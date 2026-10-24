// Records both legs of a call into ONE stereo track: left = the caller's mic,
// right = the lead's audio off the WebRTC peer connection.
//
// Keeping the legs on separate channels is what makes speaker attribution exact.
// A mixed-mono recording would need diarization, which guesses — and guesses wrong
// exactly when two people talk over each other, which is the part of a sales call
// you most want to read back.

export type RecorderHandle = {
  stop: () => Promise<Blob | null>
  cancel: () => void
}

function pickMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return candidates.find((type) => MediaRecorder.isTypeSupported(type))
}

export function startStereoRecording(
  local: MediaStream | undefined,
  remote: MediaStream | undefined,
): RecorderHandle | null {
  if (!local || !remote) return null
  if (typeof MediaRecorder === 'undefined') return null

  const mimeType = pickMimeType()
  if (!mimeType) return null

  let context: AudioContext
  try {
    context = new AudioContext()
  } catch {
    return null
  }

  const merger = context.createChannelMerger(2)
  // Input 0 is the left channel, input 1 the right. ChannelMerger inputs are mono,
  // so each source contributes its first channel.
  context.createMediaStreamSource(local).connect(merger, 0, 0)
  context.createMediaStreamSource(remote).connect(merger, 0, 1)

  const destination = context.createMediaStreamDestination()
  merger.connect(destination)

  const chunks: Blob[] = []
  const recorder = new MediaRecorder(destination.stream, {
    mimeType,
    audioBitsPerSecond: 128_000,
  })
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }

  // Chrome suspends a context created outside a user gesture; the dial button is a
  // gesture, but resume() is cheap insurance against a silent recording.
  void context.resume().catch(() => undefined)
  recorder.start(1000)

  const teardown = () => {
    merger.disconnect()
    destination.stream.getTracks().forEach((track) => track.stop())
    void context.close().catch(() => undefined)
  }

  return {
    stop: () =>
      new Promise<Blob | null>((resolve) => {
        if (recorder.state === 'inactive') {
          teardown()
          resolve(chunks.length ? new Blob(chunks, { type: mimeType }) : null)
          return
        }
        recorder.onstop = () => {
          teardown()
          resolve(chunks.length ? new Blob(chunks, { type: mimeType }) : null)
        }
        recorder.stop()
      }),
    cancel: () => {
      if (recorder.state !== 'inactive') recorder.stop()
      chunks.length = 0
      teardown()
    },
  }
}

// Unprocessed, so the mic check hears what the mic really delivers and Chrome's auto-gain can't move the OS volume.
const RAW_MIC: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

// Posts every rendered frame, so the mic check gets lossless PCM instead of decoded Opus.
const PCM_TAP = `registerProcessor('pcm-tap', class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true }
})`

export type MicRecording = { blob: Blob; pcm: Float32Array; sampleRate: number; label: string }

function concat(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0))
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

// Mic-only recording for the Setup page's transcript test — exercises the same
// decode + Whisper path as a real call without placing one.
export async function recordMicrophone(seconds: number, onTick: (left: number) => void): Promise<MicRecording> {
  const mimeType = pickMimeType()
  if (!mimeType) throw new TranscriptError('recorder-start', 'this browser cannot record audio')

  const stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_MIC })
  const context = new AudioContext()
  const frames: Float32Array[] = []
  const tapUrl = URL.createObjectURL(new Blob([PCM_TAP], { type: 'text/javascript' }))
  try {
    await context.audioWorklet.addModule(tapUrl)
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop())
    void context.close().catch(() => undefined)
    throw new TranscriptError('recorder-start', `mic check could not start: ${(err as Error).message}`)
  } finally {
    URL.revokeObjectURL(tapUrl)
  }
  const tap = new AudioWorkletNode(context, 'pcm-tap')
  tap.port.onmessage = (event: MessageEvent<Float32Array>) => frames.push(event.data)
  // A worklet only runs while the graph pulls it, so route it to the speakers at zero volume.
  const mute = context.createGain()
  mute.gain.value = 0
  context.createMediaStreamSource(stream).connect(tap).connect(mute).connect(context.destination)
  void context.resume().catch(() => undefined)

  const recorder = new MediaRecorder(stream, { mimeType })
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }

  return new Promise<MicRecording>((resolve, reject) => {
    let left = seconds
    onTick(left)
    const timer = window.setInterval(() => {
      left--
      onTick(left)
      if (left <= 0) {
        window.clearInterval(timer)
        recorder.stop()
      }
    }, 1000)
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop())
      const sampleRate = context.sampleRate
      void context.close().catch(() => undefined)
      if (!chunks.length) reject(new TranscriptError('empty-recording', 'the recorder captured no audio'))
      else
        resolve({
          blob: new Blob(chunks, { type: mimeType }),
          pcm: concat(frames),
          sampleRate,
          label: stream.getAudioTracks()[0]?.label ?? '',
        })
    }
    recorder.start(1000)
  })
}

export class TranscriptError extends Error {
  constructor(
    readonly stage: string,
    message: string,
  ) {
    super(message)
  }
}

export type SplitAudio = {
  caller: Float32Array
  lead: Float32Array | null
  durationSec: number
  callerPeak: number
  leadPeak: number
}

// Loudest sample, 0..1. Used to tell a muted/wrong mic apart from a transcriber failure.
function peakOf(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] ?? 0)
    if (v > peak) peak = v
  }
  return peak
}

const WHISPER_SAMPLE_RATE = 16_000

/**
 * Decode the recording and resample to the 16 kHz mono-per-channel that Whisper
 * expects. Resampling happens in an OfflineAudioContext so the browser's own
 * high-quality resampler does the work rather than a hand-rolled decimator.
 */
export async function splitChannelsAt16k(blob: Blob): Promise<SplitAudio | null> {
  const bytes = await blob.arrayBuffer()

  const decodeContext = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await decodeContext.decodeAudioData(bytes)
  } catch (err) {
    throw new TranscriptError('decode', `could not decode the recording: ${(err as Error).message}`)
  } finally {
    void decodeContext.close().catch(() => undefined)
  }

  if (decoded.duration < 0.5) return null

  const channels = Math.min(2, decoded.numberOfChannels)
  const frames = Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE)
  const offline = new OfflineAudioContext(channels, frames, WHISPER_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()

  const rendered = await offline.startRendering()

  const caller = rendered.getChannelData(0).slice()
  const lead = rendered.numberOfChannels > 1 ? rendered.getChannelData(1).slice() : null
  return {
    caller,
    lead,
    durationSec: decoded.duration,
    callerPeak: peakOf(caller),
    leadPeak: lead ? peakOf(lead) : 0,
  }
}
