import { useCallback, useEffect, useRef, useState } from 'react'
import { Call, Device } from '@twilio/voice-sdk'
import { api, type CallQuality } from '../api'
import { livePeerConnection, readOutbound, readVoice, trackingPeerConnection, type VoiceStats } from '../lib/callStats'
import { startStereoRecording, TranscriptError, type RecorderHandle } from '../lib/callRecorder'
import {
  abortTranscription,
  clearPendingAbort,
  preloadTranscriber,
  transcribeRecording,
  type TranscriptionStage,
} from '../lib/transcription'
import { formatFriendly, friendlyError, isPreAnswerHangup, type TwilioLikeError } from '../lib/callErrors'
import {
  deletePending,
  loadPending,
  PENDING_MAX_AGE_MS,
  savePending,
  type PendingJob,
} from '../lib/pendingTranscripts'

export type CallPhase = 'idle' | 'connecting' | 'ringing' | 'connected' | 'ended'

export type PreflightResult = {
  quality: string
  rttMs: number | null
  jitterMs: number | null
  mos: number | null
}

// Callers can sit far from the US leads they dial. The default 'roaming' edge
// picks the edge nearest the *caller* (Singapore or Frankfurt) and then hops
// Twilio's backbone to the US anyway — two legs instead of one. Anchoring in
// Ashburn puts the WebRTC leg straight into Virginia where the PSTN leg egresses.
const EDGES = ['ashburn', 'frankfurt']

// Opus carries in-band FEC; PCMU (the SDK default) turns every packet the Wi-Fi uplink drops into a gap.
const CODECS = [Call.Codec.Opus, Call.Codec.PCMU]

// Chrome's auto-gain swung the OS mic volume 0.27 ↔ 0.72 and clipped; the level is set once in Sound settings.
const CALL_MIC: MediaTrackConstraints = { autoGainControl: false, echoCancellation: true, noiseSuppression: true }

const OUT_LOSS_WARN_PCT = 5
const OUT_LOSS_CLEAR_PCT = 2
const OUT_LOSS_TEXT = 'They are losing your voice right now. Stop, then ask "can you hear me okay?"'
const MAX_EVENTS = 60

const LIVE_WARNING_TEXT: Record<string, string> = {
  'high-packet-loss': 'Your internet is dropping their audio — you may miss words. Ask them to repeat.',
  'high-packets-lost-fraction': 'Your internet is dropping their audio — you may miss words. Ask them to repeat.',
  'low-bytes-sent': 'Your voice is not reaching them. Check your internet and that you are not muted.',
  'constant-audio-input-level': 'Your microphone is not picking up any sound. Check your headset mic.',
  'high-jitter': 'Your connection is unstable — your voice may sound choppy to them.',
  'low-mos': 'Call quality is poor right now. Speak slowly and check they can hear you.',
  'high-rtt': 'Big delay on the line — pause before you reply so you do not talk over them.',
}

export const TRANSCRIPT_STAGE_TEXT: Record<string, string> = {
  'recorder-start': 'Recording could not start, so this call will have no transcript.',
  'empty-recording': 'The recording came out empty, so there is no transcript for the last call.',
  'no-call-id': 'The last call could not be matched for its transcript.',
  'too-short': 'The last call was too short to transcribe.',
  decode: "The last call's recording could not be read, so there is no transcript.",
  'model-load': 'The transcription model failed to load. Check your internet; it will retry.',
  garbled: 'The transcriber returned nonsense for the last call, so it was not saved.',
  expired: 'A call waited more than 2 days for its transcript and was dropped.',
  transcribe: 'Transcribing the last call failed.',
  'worker-crash': 'Transcription crashed on the last call; the next call will start fresh.',
  'no-speech': 'No speech was heard on the last call, so there is no transcript.',
  'silent-audio': 'Your microphone recorded silence. In Chrome, check the right microphone is selected.',
  upload: 'The transcript was made but could not be saved. Check your internet.',
}

type QualityAcc = {
  n: number
  micSum: number
  micDead: number
  lossMax: number
  lossSum: number
  mosSum: number
  mosN: number
  rttMax: number
  jitterSum: number
  warnings: Set<string>
  codec: string | null
  outN: number
  outLossMax: number
  outJitterSum: number
  outBase: { lost: number; sent: number } | null
  outLast: { lost: number; sent: number } | null
  outWarned: boolean
  voiceLast: VoiceStats | null
  voiceDbs: number[]
  voicePeak: number
  events: { name: string; t: number; cleared: boolean }[]
}

const emptyQuality = (): QualityAcc => ({
  n: 0,
  micSum: 0,
  micDead: 0,
  lossMax: 0,
  lossSum: 0,
  mosSum: 0,
  mosN: 0,
  rttMax: 0,
  jitterSum: 0,
  warnings: new Set(),
  codec: null,
  outN: 0,
  outLossMax: 0,
  outJitterSum: 0,
  outBase: null,
  outLast: null,
  outWarned: false,
  voiceLast: null,
  voiceDbs: [],
  voicePeak: 0,
  events: [],
})

function logEvent(q: QualityAcc, name: string, cleared: boolean): void {
  if (q.events.length < MAX_EVENTS) q.events.push({ name, t: Date.now(), cleared })
}

// One level per second of what we send; muted seconds carry zero energy and are skipped rather than counted as -∞ dB.
function sampleVoice(q: QualityAcc, voice: VoiceStats | null): void {
  if (!voice) return
  const last = q.voiceLast
  q.voiceLast = voice
  q.voicePeak = Math.max(q.voicePeak, voice.level)
  if (!last || voice.seconds <= last.seconds) return
  const energy = voice.energy - last.energy
  if (energy > 0) q.voiceDbs.push(10 * Math.log10(energy / (voice.seconds - last.seconds)))
}

function micSettings(stream: MediaStream | undefined): CallQuality['mic'] {
  const track = stream?.getAudioTracks()[0]
  if (!track) return null
  const settings = track.getSettings()
  return {
    label: track.label.slice(0, 80),
    autoGainControl: settings.autoGainControl ?? null,
    echoCancellation: settings.echoCancellation ?? null,
    noiseSuppression: settings.noiseSuppression ?? null,
  }
}

type CallMeta = { answeredAt: number; edge: string | null; mic: CallQuality['mic'] }

function summarize(q: QualityAcc, meta: CallMeta): CallQuality {
  const avg = (sum: number, n: number) => (n ? Math.round((sum / n) * 10) / 10 : 0)
  const sent = q.outBase && q.outLast ? q.outLast.sent - q.outBase.sent : 0
  const lost = q.outBase && q.outLast ? Math.max(0, q.outLast.lost - q.outBase.lost) : 0
  const voice = [...q.voiceDbs].sort((a, b) => a - b)
  const voiceAt = (p: number) => Math.round((voice[Math.min(voice.length - 1, Math.floor(p * voice.length))] ?? 0) * 10) / 10
  return {
    samples: q.n,
    avgMicLevel: avg(q.micSum, q.n),
    silentMicPct: avg(q.micDead * 100, q.n),
    // The SDK's packetsLostFraction is already a percentage.
    maxPacketLossPct: Math.round(q.lossMax * 10) / 10,
    avgPacketLossPct: avg(q.lossSum, q.n),
    avgMos: q.mosN ? avg(q.mosSum, q.mosN) : null,
    maxRttMs: q.rttMax,
    avgJitterMs: avg(q.jitterSum, q.n),
    warnings: [...q.warnings],
    outLossPct: sent > 0 ? Math.round((lost / sent) * 1000) / 10 : null,
    maxOutLossPct: q.outN ? Math.round(q.outLossMax * 10) / 10 : null,
    avgOutJitterMs: q.outN ? avg(q.outJitterSum, q.outN) : null,
    voiceDb: voice.length ? voiceAt(0.9) : null,
    voiceFloorDb: voice.length ? voiceAt(0.1) : null,
    voicePeakDb: q.voicePeak > 0 ? Math.round(20 * Math.log10(q.voicePeak) * 10) / 10 : null,
    codec: q.codec,
    edge: meta.edge,
    mic: meta.mic,
    warningEvents: q.events.map((e) => ({
      name: e.name,
      at: Math.round((e.t - meta.answeredAt) / 100) / 10,
      cleared: e.cleared,
    })),
  }
}

type TranscriptJob = { kind: 'preload' } | { kind: 'call'; job: PendingJob }

// Worth another try the next time the Dial page opens; anything else about the recording itself is final.
const RETRY_LATER = new Set(['upload', 'model-load', 'worker-crash'])

export type InboundCall = { from: string; status: 'ringing' | 'connected' }

export function useTwilioDevice({ preload = false, orgId }: { preload?: boolean; orgId?: string } = {}) {
  const deviceRef = useRef<Device | null>(null)
  // Device.activeCall was removed in SDK v2 — the Call returned by connect() is the
  // only handle to mute/hangup, so it has to be held here.
  const callRef = useRef<Call | null>(null)
  const answeredAtRef = useRef<number | null>(null)
  const recorderRef = useRef<RecorderHandle | null>(null)
  // The disposition flow clears callSid as soon as the caller advances, but the
  // transcript still has to land against the right call — so hold it separately.
  const recordingSidRef = useRef<string | null>(null)

  const [phase, setPhase] = useState<CallPhase>('idle')
  const [callSid, setCallSid] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deviceReady, setDeviceReady] = useState(false)
  const [talkSeconds, setTalkSeconds] = useState(0)
  const [lastDialStatus, setLastDialStatus] = useState<string | null>(null)
  const [transcribing, setTranscribing] = useState<TranscriptionStage | null>(null)
  const [recording, setRecording] = useState(false)
  const [transcriptProblem, setTranscriptProblem] = useState<string | null>(null)
  const jobsRef = useRef<TranscriptJob[]>([])
  const runningJobRef = useRef<TranscriptJob | null>(null)
  const callActiveRef = useRef(false)
  const [queuedTranscripts, setQueuedTranscripts] = useState(0)
  const qualityRef = useRef<QualityAcc>(emptyQuality())
  const qualitySidRef = useRef<string | null>(null)
  const edgeRef = useRef<string | null>(null)
  const micRef = useRef<CallQuality['mic']>(null)
  const [callMic, setCallMic] = useState<string | null>(null)
  const [sdkWarning, setSdkWarning] = useState<string | null>(null)
  const [outboundWarning, setOutboundWarning] = useState<string | null>(null)
  // Inbound calls are rung by the receptionist worker (<Dial><Client>) and live beside the
  // outbound phase machine rather than inside it: they have no lead, poll or disposition.
  const inboundCallRef = useRef<Call | null>(null)
  const inboundAnsweredAtRef = useRef<number | null>(null)
  const [inbound, setInbound] = useState<InboundCall | null>(null)
  const [inboundSeconds, setInboundSeconds] = useState(0)
  const [incomingEnabled, setIncomingEnabled] = useState(false)
  const [incomingBusy, setIncomingBusy] = useState(false)

  // Runs after hangup, while the caller is already dispositioning or dialing the
  // next lead. Nothing here is allowed to throw into the call path.
  const reportTranscriptFailure = useCallback((sid: string | null, stage: string, message: string) => {
    setTranscriptProblem(TRANSCRIPT_STAGE_TEXT[stage] ?? `Transcript failed (${stage}).`)
    if (sid) void api.reportTranscriptError(sid, { stage, message }).catch(() => undefined)
  }, [])

  // Runs after hangup, while the caller is already dispositioning or dialing the
  // next lead. Nothing here is allowed to throw into the call path.
  const countQueued = useCallback(() => {
    const calls = jobsRef.current.filter((j) => j.kind === 'call').length
    setQueuedTranscripts(calls + (runningJobRef.current?.kind === 'call' ? 1 : 0))
  }, [])

  // One job at a time, and only while no call is live — never compete with call audio.
  const pumpJobs = useCallback(async () => {
    if (runningJobRef.current || callActiveRef.current) return
    const job = jobsRef.current.shift()
    if (!job) return
    runningJobRef.current = job
    countQueued()
    clearPendingAbort()
    try {
      if (job.kind === 'preload') {
        await preloadTranscriber(setTranscribing)
      } else {
        const pending = job.job
        const result = await transcribeRecording(pending, setTranscribing, () => void savePending(pending))
        try {
          await api.saveTranscript(pending.sid, result)
        } catch (err) {
          throw new TranscriptError('upload', (err as Error).message)
        }
        void deletePending(pending.sid)
        setTranscriptProblem(result.warning ? 'Transcript saved, but only one side could be heard.' : null)
      }
    } catch (err) {
      const stage = err instanceof TranscriptError ? err.stage : 'unknown'
      if (stage === 'aborted') jobsRef.current.unshift(job)
      else if (job.kind === 'call') {
        reportTranscriptFailure(job.job.sid, stage, (err as Error).message)
        if (!RETRY_LATER.has(stage)) void deletePending(job.job.sid)
      }
    } finally {
      runningJobRef.current = null
      setTranscribing(null)
      countQueued()
      void pumpJobs()
    }
  }, [countQueued, reportTranscriptFailure])

  // Runs after hangup, while the caller is already dispositioning or dialing the
  // next lead. Nothing here is allowed to throw into the call path.
  const finishRecording = useCallback(
    async (wasAnswered: boolean) => {
      const recorder = recorderRef.current
      const sid = recordingSidRef.current
      recorderRef.current = null
      recordingSidRef.current = null
      setRecording(false)
      if (!recorder) return

      // Recording begins at ringback, so an unanswered dial yields nothing but ring
      // tone. Roughly three in four dials end that way — transcribing them would burn
      // the caller's CPU between calls and fill the dashboard with junk.
      if (!wasAnswered) {
        recorder.cancel()
        return
      }

      try {
        const blob = await recorder.stop()
        if (!blob) throw new TranscriptError('empty-recording', 'the recorder captured no audio')
        if (!sid) throw new TranscriptError('no-call-id', 'the call had no id to attach the transcript to')
        const pending: PendingJob = { sid, orgId, blob, createdAt: Date.now() }
        void savePending(pending)
        jobsRef.current.push({ kind: 'call', job: pending })
        countQueued()
        void pumpJobs()
      } catch (err) {
        const stage = err instanceof TranscriptError ? err.stage : 'unknown'
        reportTranscriptFailure(sid, stage, (err as Error).message)
      }
    },
    [orgId, countQueued, pumpJobs, reportTranscriptFailure],
  )

  const teardownCall = useCallback(() => {
    // Read the answer flag before clearing it — finishRecording needs to know whether
    // the lead actually picked up.
    const answeredAt = answeredAtRef.current
    const wasAnswered = answeredAt !== null
    const qualitySid = qualitySidRef.current
    qualitySidRef.current = null
    setSdkWarning(null)
    setOutboundWarning(null)
    if (answeredAt !== null && qualitySid && qualityRef.current.n > 0) {
      const meta = { answeredAt, edge: edgeRef.current, mic: micRef.current }
      void api.saveCallQuality(qualitySid, summarize(qualityRef.current, meta)).catch(() => undefined)
    }
    callRef.current = null
    answeredAtRef.current = null
    setMuted(false)
    setCallMic(null)
    callActiveRef.current = false
    void finishRecording(wasAnswered)
    void pumpJobs()
  }, [finishRecording, pumpJobs])

  // Created lazily and only from inside a click handler: Chrome refuses to start an
  // AudioContext without a user gesture, and a Device built on page load produces a
  // silent first call.
  const ensureDevice = useCallback(async (): Promise<Device> => {
    if (deviceRef.current) return deviceRef.current

    const { token } = await api.twilioToken()
    // allowIncomingWhileBusy so a callback during a live dial reaches our 'incoming'
    // handler, which rejects it at once and the AI answers without a 10s ring-out.
    const device = new Device(token, {
      edge: EDGES,
      codecPreferences: CODECS,
      RTCPeerConnection: trackingPeerConnection(),
      logLevel: 'error',
      allowIncomingWhileBusy: true,
    })

    device.on('error', (err: TwilioLikeError) => {
      setError(formatFriendly(friendlyError(err)))
    })

    device.on('tokenWillExpire', async () => {
      try {
        const refreshed = await api.twilioToken()
        device.updateToken(refreshed.token)
      } catch {
        setError(formatFriendly(friendlyError({ code: 20104 })))
      }
    })

    device.on('registered', () => setIncomingEnabled(true))
    device.on('unregistered', () => setIncomingEnabled(false))

    deviceRef.current = device
    setDeviceReady(true)
    return device
  }, [])

  const endInbound = useCallback(() => {
    const wasLive = inboundAnsweredAtRef.current !== null
    inboundCallRef.current = null
    inboundAnsweredAtRef.current = null
    setInbound(null)
    setInboundSeconds(0)
    setMuted(false)
    if (wasLive) {
      callActiveRef.current = false
      void pumpJobs()
    }
  }, [pumpJobs])

  const onIncoming = useCallback(
    (call: Call) => {
      // Busy with an outbound call or another inbound one: refuse so the AI picks up now.
      if (callActiveRef.current || inboundCallRef.current) {
        call.reject()
        return
      }
      inboundCallRef.current = call
      setInbound({ from: String(call.parameters?.From ?? ''), status: 'ringing' })
      // cancel = the caller hung up, or the ring window ended and the AI took over.
      call.on('cancel', endInbound)
      call.on('reject', endInbound)
      call.on('disconnect', endInbound)
      call.on('error', (err: TwilioLikeError) => {
        setError(formatFriendly(friendlyError(err)))
        endInbound()
      })
    },
    [endInbound],
  )

  const enableIncoming = useCallback(async () => {
    setError(null)
    setIncomingBusy(true)
    try {
      const device = await ensureDevice()
      if (!device.listenerCount('incoming')) device.on('incoming', onIncoming)
      await device.register()
    } catch (err) {
      setError(formatFriendly(friendlyError(err)))
    } finally {
      setIncomingBusy(false)
    }
  }, [ensureDevice, onIncoming])

  const disableIncoming = useCallback(async () => {
    setIncomingBusy(true)
    try {
      await deviceRef.current?.unregister()
    } catch {
      // Already unregistered; the 'unregistered' event keeps state honest either way.
    } finally {
      setIncomingBusy(false)
    }
  }, [])

  const acceptInbound = useCallback(() => {
    const call = inboundCallRef.current
    if (!call) return
    callActiveRef.current = true
    if (runningJobRef.current?.kind === 'call') abortTranscription()
    call.accept({ rtcConstraints: { audio: CALL_MIC } })
    inboundAnsweredAtRef.current = Date.now()
    setInbound((current) => (current ? { ...current, status: 'connected' } : current))
  }, [])

  const rejectInbound = useCallback(() => {
    inboundCallRef.current?.reject()
    endInbound()
  }, [endInbound])

  const hangupInbound = useCallback(() => {
    inboundCallRef.current?.disconnect()
    endInbound()
  }, [endInbound])

  // Twilio's RTCP reports on our stream; the SDK's own loss figures only cover the lead's audio.
  const sampleOutbound = useCallback(async (q: QualityAcc) => {
    const pc = livePeerConnection()
    if (!pc) return
    const report = await pc.getStats()
    if (qualityRef.current !== q || answeredAtRef.current === null) return
    sampleVoice(q, readVoice(report))
    const out = readOutbound(report)
    if (!out) return
    q.outN++
    q.outLossMax = Math.max(q.outLossMax, out.fractionLostPct)
    q.outJitterSum += out.jitterMs
    const totals = { lost: out.packetsLost, sent: out.packetsSent }
    q.outBase ??= totals
    q.outLast = totals
    if (!q.outWarned && out.fractionLostPct >= OUT_LOSS_WARN_PCT) {
      q.outWarned = true
      logEvent(q, 'outbound-loss', false)
      setOutboundWarning(OUT_LOSS_TEXT)
    } else if (q.outWarned && out.fractionLostPct < OUT_LOSS_CLEAR_PCT) {
      q.outWarned = false
      logEvent(q, 'outbound-loss', true)
      setOutboundWarning(null)
    }
  }, [])

  const dial = useCallback(
    async (phone: string, options: { record?: boolean } = {}) => {
      setError(null)
      setLastDialStatus(null)
      setTalkSeconds(0)
      setCallSid(null)
      setPhase('connecting')
      callActiveRef.current = true
      // Only transcription is CPU worth pausing; restarting the model download on every dial meant it never finished.
      if (runningJobRef.current?.kind === 'call') abortTranscription()

      try {
        const device = await ensureDevice()
        // The param is deliberately not named "To": Twilio sets its own To on every
        // webhook, and shadowing it makes the server ambiguous to reason about.
        const call = await device.connect({ params: { LeadPhone: phone }, rtcConstraints: { audio: CALL_MIC } })
        callRef.current = call
        qualityRef.current = emptyQuality()
        edgeRef.current = null
        micRef.current = null

        // Samples arrive every second; only the talk portion says anything about what the lead heard.
        call.on('sample', (sample: { audioInputLevel: number; packetsLostFraction: number; mos: number | null; rtt: number; jitter: number; codecName?: string }) => {
          if (answeredAtRef.current === null) return
          const q = qualityRef.current
          q.n++
          q.micSum += sample.audioInputLevel
          if (sample.audioInputLevel < 20) q.micDead++
          q.lossMax = Math.max(q.lossMax, sample.packetsLostFraction)
          q.lossSum += sample.packetsLostFraction
          if (sample.mos != null) {
            q.mosSum += sample.mos
            q.mosN++
          }
          q.rttMax = Math.max(q.rttMax, sample.rtt)
          q.jitterSum += sample.jitter
          if (sample.codecName) q.codec = sample.codecName
          void sampleOutbound(q)
        })
        call.on('warning', (name: string) => {
          qualityRef.current.warnings.add(name)
          logEvent(qualityRef.current, name, false)
          if (LIVE_WARNING_TEXT[name]) setSdkWarning(LIVE_WARNING_TEXT[name] ?? null)
        })
        call.on('warning-cleared', (name: string) => {
          logEvent(qualityRef.current, name, true)
          if (LIVE_WARNING_TEXT[name]) setSdkWarning(null)
        })

        call.on('accept', () => {
          // With answerOnBridge this fires when ringback media arrives, NOT when the
          // lead picks up. The real answer moment comes from the server poll below.
          setPhase('ringing')
          const sid = call.parameters?.CallSid
          if (sid) setCallSid(sid)
          qualitySidRef.current = sid ?? null
          edgeRef.current = device.edge
          micRef.current = micSettings(call.getLocalStream())
          setCallMic(micRef.current?.label ?? null)

          // Both media streams only exist once the peer connection is up, so this is
          // the earliest point recording can start. It captures ringback too, which
          // is harmless and makes disconnected numbers obvious in the transcript.
          if (options.record && !recorderRef.current) {
            const handle = sid ? startStereoRecording(call.getLocalStream(), call.getRemoteStream()) : null
            if (handle) {
              recorderRef.current = handle
              recordingSidRef.current = sid ?? null
              setRecording(true)
            } else {
              reportTranscriptFailure(sid ?? null, 'recorder-start', 'recording could not start for this call')
            }
          }
        })

        call.on('disconnect', () => {
          setPhase('ended')
          teardownCall()
        })

        call.on('cancel', () => {
          setPhase('ended')
          teardownCall()
        })

        call.on('error', (err: TwilioLikeError) => {
          // Before pickup these just mean no-answer/busy/unreachable; the dial outcome poll explains it.
          const unanswered = answeredAtRef.current === null
          if (!(unanswered && isPreAnswerHangup(err))) setError(formatFriendly(friendlyError(err)))
          setPhase('ended')
          teardownCall()
        })

        const sid = call.parameters?.CallSid
        if (sid) setCallSid(sid)
      } catch (err) {
        setError(formatFriendly(friendlyError(err)))
        setPhase('idle')
        teardownCall()
      }
    },
    [ensureDevice, teardownCall, reportTranscriptFailure, sampleOutbound],
  )

  const hangup = useCallback(() => {
    callRef.current?.disconnect()
    deviceRef.current?.disconnectAll()
    setPhase('ended')
    teardownCall()
  }, [teardownCall])

  const toggleMute = useCallback(() => {
    const call = callRef.current ?? (inboundAnsweredAtRef.current !== null ? inboundCallRef.current : null)
    if (!call) return
    const next = !call.isMuted()
    call.mute(next)
    setMuted(next)
  }, [])

  const sendDigits = useCallback((digits: string) => {
    callRef.current?.sendDigits(digits)
  }, [])

  const reset = useCallback(() => {
    setPhase('idle')
    setCallSid(null)
    setTalkSeconds(0)
    setLastDialStatus(null)
    setError(null)
  }, [])

  // Poll the server for the true answer moment and the final dial outcome. The SDK
  // cannot tell us either of these when answerOnBridge is on.
  useEffect(() => {
    if (!callSid) return
    if (phase !== 'ringing' && phase !== 'connected' && phase !== 'ended') return

    let cancelled = false
    const timer = window.setInterval(async () => {
      try {
        const status = await api.callStatus(callSid)
        if (cancelled) return

        if (status.answeredAt && answeredAtRef.current === null) {
          answeredAtRef.current = new Date(status.answeredAt).getTime()
          setPhase((current) => (current === 'ringing' ? 'connected' : current))
        }
        if (status.dialStatus) setLastDialStatus(status.dialStatus)
        if (status.endedAt) window.clearInterval(timer)
      } catch {
        // The Call row appears a moment after the webhook fires; 404s here are normal.
      }
    }, 2000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [callSid, phase])

  useEffect(() => {
    if (inbound?.status !== 'connected') return
    const timer = window.setInterval(() => {
      if (inboundAnsweredAtRef.current === null) return
      setInboundSeconds(Math.floor((Date.now() - inboundAnsweredAtRef.current) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [inbound?.status])

  // Talk timer runs from the server-confirmed answer time, so it measures the
  // conversation rather than the conversation plus however long it rang.
  useEffect(() => {
    if (phase !== 'connected') return
    const timer = window.setInterval(() => {
      if (answeredAtRef.current === null) return
      setTalkSeconds(Math.floor((Date.now() - answeredAtRef.current) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [phase])

  const runPreflight = useCallback(async (): Promise<PreflightResult> => {
    const { token } = await api.twilioToken()

    return new Promise((resolve, reject) => {
      const test = Device.runPreflight(token, { edge: EDGES[0] })
      const timeout = window.setTimeout(() => reject(new Error(formatFriendly(friendlyError({ code: 53000 })))), 60000)

      test.on('completed', (report: Record<string, never>) => {
        window.clearTimeout(timeout)
        const stats = (report as { stats?: Record<string, { average?: number }> }).stats
        resolve({
          quality: String((report as { callQuality?: string }).callQuality ?? 'unknown'),
          rttMs: stats?.rtt?.average ?? null,
          jitterMs: stats?.jitter?.average ?? null,
          mos: stats?.mos?.average ?? null,
        })
      })

      test.on('failed', (err: TwilioLikeError) => {
        window.clearTimeout(timeout)
        reject(new Error(formatFriendly(friendlyError(err))))
      })
    })
  }, [])

  // The page that preloads also owns the queue: recordings left from a closed tab resume here.
  useEffect(() => {
    if (!preload) return
    jobsRef.current.push({ kind: 'preload' })
    let cancelled = false
    void loadPending().then((saved) => {
      if (cancelled) return
      const queued = new Set(jobsRef.current.flatMap((j) => (j.kind === 'call' ? [j.job.sid] : [])))
      for (const pending of saved.sort((a, b) => a.createdAt - b.createdAt)) {
        if (queued.has(pending.sid)) continue
        // Another workspace's recording waits until that workspace is open again.
        if (pending.orgId && pending.orgId !== orgId) continue
        if (Date.now() - pending.createdAt > PENDING_MAX_AGE_MS) {
          void deletePending(pending.sid)
          reportTranscriptFailure(pending.sid, 'expired', 'waited more than 48 hours to be transcribed')
          continue
        }
        jobsRef.current.push({ kind: 'call', job: pending })
      }
      countQueued()
      void pumpJobs()
    })
    void pumpJobs()
    return () => {
      cancelled = true
    }
  }, [preload, orgId, pumpJobs, countQueued, reportTranscriptFailure])

  // Queued recordings survive a closed tab now; only a recording still in progress would be lost.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!recorderRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  useEffect(() => {
    return () => {
      recorderRef.current?.cancel()
      recorderRef.current = null
      deviceRef.current?.destroy()
      deviceRef.current = null
    }
  }, [])

  return {
    phase,
    callSid,
    muted,
    error,
    deviceReady,
    talkSeconds,
    lastDialStatus,
    recording,
    transcribing,
    transcriptProblem,
    // What the lead hears outranks what reaches us.
    liveWarning: outboundWarning ?? sdkWarning,
    callMic,
    queuedTranscripts,
    inbound,
    inboundSeconds,
    incomingEnabled,
    incomingBusy,
    enableIncoming,
    disableIncoming,
    acceptInbound,
    rejectInbound,
    hangupInbound,
    dial,
    hangup,
    toggleMute,
    sendDigits,
    reset,
    runPreflight,
    clearError: () => setError(null),
  }
}
