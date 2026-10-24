import { useCallback, useEffect, useRef, useState } from 'react'
import type { CallPhase, InboundCall, PreflightResult, useTwilioDevice } from '../hooks/useTwilioDevice'
import type { TranscriptionStage } from '../lib/transcription'
import * as store from './store'

type Device = ReturnType<typeof useTwilioDevice>

const RING_MS = 2600
const CONNECT_MS = 700
const TRANSCRIBE_MS = 3200
const DEMO_MIC = 'USB Headset (demo)'

// Same surface as useTwilioDevice, driven by timers: a dial rings, connects and hangs up without Twilio.
export function useDemoDevice(_options: { preload?: boolean; orgId?: string } = {}): Device {
  const [phase, setPhase] = useState<CallPhase>('idle')
  const [callSid, setCallSid] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [talkSeconds, setTalkSeconds] = useState(0)
  const [lastDialStatus, setLastDialStatus] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState<TranscriptionStage | null>(null)
  const [transcriptProblem, setTranscriptProblem] = useState<string | null>(null)
  const [callMic, setCallMic] = useState<string | null>(null)
  const [inbound, setInbound] = useState<InboundCall | null>(null)
  const [inboundSeconds, setInboundSeconds] = useState(0)
  const [incomingEnabled, setIncomingEnabled] = useState(false)
  const [incomingBusy, setIncomingBusy] = useState(false)

  const timers = useRef<number[]>([])
  const answeredAt = useRef<number | null>(null)
  const sidRef = useRef<string | null>(null)
  const recordRef = useRef(false)
  const inboundRef = useRef<{ from: string; answeredAt: number | null } | null>(null)

  const after = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  const dial = useCallback(
    async (phone: string, options: { record?: boolean } = {}) => {
      setError(null)
      setLastDialStatus(null)
      setTalkSeconds(0)
      setCallSid(null)
      setTranscriptProblem(null)
      setPhase('connecting')
      recordRef.current = Boolean(options.record)
      after(CONNECT_MS, () => {
        try {
          const sid = store.startCall(phone)
          sidRef.current = sid
          setCallSid(sid)
          setCallMic(DEMO_MIC)
          setRecording(recordRef.current)
          setPhase('ringing')
          after(RING_MS, () => {
            answeredAt.current = Date.now()
            store.answerCall(sid)
            setPhase('connected')
          })
        } catch (err) {
          setError((err as Error).message)
          setPhase('idle')
        }
      })
    },
    [after],
  )

  const hangup = useCallback(() => {
    clearTimers()
    const sid = sidRef.current
    const answered = answeredAt.current
    const seconds = answered ? Math.round((Date.now() - answered) / 1000) : 0
    answeredAt.current = null
    setPhase('ended')
    setRecording(false)
    setCallMic(null)
    setMuted(false)
    if (!sid) return
    store.endCall(sid, seconds)
    setLastDialStatus(answered ? 'completed' : 'canceled')
    if (!answered || !recordRef.current) return
    // Mirrors the real flow: transcription runs after hangup, while the caller picks an outcome.
    setTranscribing({ callSid: sid, stage: 'transcribing', pct: null })
    after(TRANSCRIBE_MS, () => {
      setTranscribing(null)
      if (!store.transcribeDemoCall(sid)) setTranscriptProblem('The last call was too short to transcribe.')
    })
  }, [after, clearTimers])

  useEffect(() => {
    if (phase !== 'connected') return
    const timer = window.setInterval(() => {
      if (answeredAt.current !== null) setTalkSeconds(Math.floor((Date.now() - answeredAt.current) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [phase])

  const toggleMute = useCallback(() => {
    if (answeredAt.current !== null || inboundRef.current?.answeredAt) setMuted((m) => !m)
  }, [])

  const reset = useCallback(() => {
    setPhase('idle')
    setCallSid(null)
    setTalkSeconds(0)
    setLastDialStatus(null)
    setError(null)
    sidRef.current = null
  }, [])

  const endInbound = useCallback((handledBy: 'human' | 'ai') => {
    const call = inboundRef.current
    inboundRef.current = null
    setInbound(null)
    setInboundSeconds(0)
    setMuted(false)
    if (call) store.recordInbound(call.from, handledBy, call.answeredAt ? Math.round((Date.now() - call.answeredAt) / 1000) : 41)
  }, [])

  // Taking inbound calls rings once, a few seconds later, with a lead calling back.
  const enableIncoming = useCallback(async () => {
    setIncomingBusy(true)
    after(400, () => {
      setIncomingBusy(false)
      setIncomingEnabled(true)
      after(5000, () => {
        const caller = store.queue({ view: 'queue', limit: 5 }).leads[3]
        if (!caller || inboundRef.current || answeredAt.current !== null) return
        inboundRef.current = { from: caller.phone, answeredAt: null }
        setInbound({ from: caller.phone, status: 'ringing' })
        after(10_000, () => {
          if (inboundRef.current && !inboundRef.current.answeredAt) endInbound('ai')
        })
      })
    })
  }, [after, endInbound])

  const disableIncoming = useCallback(async () => {
    setIncomingEnabled(false)
  }, [])

  const acceptInbound = useCallback(() => {
    if (!inboundRef.current) return
    inboundRef.current.answeredAt = Date.now()
    setInbound((current) => (current ? { ...current, status: 'connected' } : current))
  }, [])

  useEffect(() => {
    if (inbound?.status !== 'connected') return
    const timer = window.setInterval(() => {
      const at = inboundRef.current?.answeredAt
      if (at) setInboundSeconds(Math.floor((Date.now() - at) / 1000))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [inbound?.status])

  const runPreflight = useCallback(
    (): Promise<PreflightResult> =>
      new Promise((resolve) => window.setTimeout(() => resolve({ quality: 'excellent', rttMs: 48, jitterMs: 1.3, mos: 4.36 }), 1500)),
    [],
  )

  return {
    phase,
    callSid,
    muted,
    error,
    deviceReady: true,
    talkSeconds,
    lastDialStatus,
    recording,
    transcribing,
    transcriptProblem,
    liveWarning: null,
    callMic,
    queuedTranscripts: 0,
    inbound,
    inboundSeconds,
    incomingEnabled,
    incomingBusy,
    enableIncoming,
    disableIncoming,
    acceptInbound,
    rejectInbound: () => endInbound('ai'),
    hangupInbound: () => endInbound('human'),
    dial,
    hangup,
    toggleMute,
    sendDigits: () => undefined,
    reset,
    runPreflight,
    clearError: () => setError(null),
  }
}
