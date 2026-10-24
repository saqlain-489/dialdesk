import { splitChannelsAt16k, TranscriptError } from './callRecorder'
import type { PendingJob } from './pendingTranscripts'
import type { AsrResult, TranscribeRequest, TranscribeResponse } from '../workers/transcribe.worker'
import type { TranscriptLine } from '../types'

export type TranscriptionStage = { callSid: string; stage: string; pct: number | null }

export const TRANSCRIBE_MODEL = 'Xenova/whisper-base.en'

let worker: Worker | null = null
// Below ~0.3% of full scale is a muted or wrong mic, not quiet speech.
const SILENCE_PEAK = 0.003

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/transcribe.worker.ts', import.meta.url), {
      type: 'module',
    })
  }
  return worker
}

type Done = Extract<TranscribeResponse, { type: 'done' }>

let abortCurrent: ((err: Error) => void) | null = null
// Set when a pause arrives before the job reached the worker (still decoding audio).
let abortPending = false

function runOnWorker(
  request: TranscribeRequest,
  onProgress: (stage: TranscriptionStage | null) => void,
  transfer: Transferable[] = [],
): Promise<Done> {
  if (abortPending) {
    abortPending = false
    return Promise.reject(new TranscriptError('aborted', 'paused for a live call'))
  }
  const active = getWorker()
  return new Promise<Done>((resolve, reject) => {
    const cleanup = () => {
      active.removeEventListener('message', handle)
      active.removeEventListener('error', crashed)
      abortCurrent = null
      onProgress(null)
    }
    const handle = (event: MessageEvent<TranscribeResponse>) => {
      const message = event.data
      if (message.id !== request.id) return
      if (message.type === 'progress') {
        onProgress({ callSid: request.id, stage: message.stage, pct: message.pct })
        return
      }
      cleanup()
      if (message.type === 'done') resolve(message)
      else reject(new TranscriptError(message.stage, message.message))
    }
    const crashed = (event: ErrorEvent) => {
      cleanup()
      // A crashed worker keeps failing every later call, so start a fresh one next time.
      worker?.terminate()
      worker = null
      reject(new TranscriptError('worker-crash', event.message || 'transcription worker crashed'))
    }
    abortCurrent = (err) => {
      cleanup()
      reject(err)
    }
    active.addEventListener('message', handle)
    active.addEventListener('error', crashed)
    active.postMessage(request, transfer)
  })
}

// Whisper at full CPU starves the live call's audio, so a running call job stops when a call starts.
export function abortTranscription(): void {
  if (!abortCurrent) {
    abortPending = true
    return
  }
  const abort = abortCurrent
  worker?.terminate()
  worker = null
  abort?.(new TranscriptError('aborted', 'paused for a live call'))
}

export function clearPendingAbort(): void {
  abortPending = false
}

// Loads (and on first use downloads, ~75 MB) the model so it never happens during a call.
export async function preloadTranscriber(onProgress: (stage: TranscriptionStage | null) => void): Promise<void> {
  await runOnWorker({ id: 'preload', kind: 'preload', model: TRANSCRIBE_MODEL }, onProgress)
}

// One channel of 16 kHz mono audio; the buffer is transferred to the worker, not copied.
export async function transcribeSamples(
  id: string,
  audio: Float32Array,
  onProgress: (stage: TranscriptionStage | null) => void,
): Promise<AsrResult | null> {
  const done = await runOnWorker({ id, kind: 'channel', model: TRANSCRIBE_MODEL, audio }, onProgress, [
    audio.buffer as ArrayBuffer,
  ])
  return done.result
}

function toLines(result: AsrResult | null | undefined, speaker: TranscriptLine['speaker']): TranscriptLine[] {
  if (!result) return []
  if (result.chunks?.length) {
    return result.chunks
      .filter((c) => c.text.trim())
      .map((c) => ({
        speaker,
        start: c.timestamp[0] ?? 0,
        end: c.timestamp[1] ?? undefined,
        text: c.text.trim(),
      }))
  }
  return result.text.trim() ? [{ speaker, start: 0, text: result.text.trim() }] : []
}

const ODD_TOKEN = /[a-z][A-Z]|[A-Za-z]\d|\d[A-Za-z]|[^\x00-\x7F‘-”…]/

// The broken GPU path wrote one fixed word salad for any audio; refuse to save anything that looks like it.
export function looksGarbled(texts: string[]): boolean {
  const filled = texts.map((t) => t.trim()).filter((t) => t.length > 40)
  if (filled.length === 2 && filled[0] === filled[1]) return true
  const tokens = texts.join(' ').split(/\s+/).filter(Boolean)
  if (tokens.length < 20) return false
  const odd = tokens.filter((t) => ODD_TOKEN.test(t) || t.length > 16).length
  return odd / tokens.length > 0.12
}

export type TranscriptResult = {
  text: string
  lines: TranscriptLine[]
  model: string
  processingSeconds: number
  peak: number
  warning?: string
}

// Sides finished on an earlier, interrupted attempt are skipped; onSide lets the hook persist each one.
export async function transcribeRecording(
  job: PendingJob,
  onProgress: (stage: TranscriptionStage | null) => void,
  onSide: (side: 'caller' | 'lead', result: AsrResult | null) => void = () => undefined,
): Promise<TranscriptResult> {
  const startedAt = performance.now()

  const split = await splitChannelsAt16k(job.blob)
  if (!split) throw new TranscriptError('too-short', 'the recording was under half a second')
  if (split.callerPeak < SILENCE_PEAK && split.leadPeak < SILENCE_PEAK) {
    throw new TranscriptError(
      'silent-audio',
      `the recording is silent (loudest point ${(Math.max(split.callerPeak, split.leadPeak) * 100).toFixed(2)}%)`,
    )
  }

  const failures: string[] = []
  for (const side of ['caller', 'lead'] as const) {
    if (job[side] !== undefined) continue
    const audio = side === 'caller' ? split.caller : split.lead
    let result: AsrResult | null = null
    if (audio && audio.length > 0) {
      try {
        result = await transcribeSamples(job.sid, audio, onProgress)
      } catch (err) {
        // A pause or a broken model is about the whole job, not this side; let it retry intact.
        if (err instanceof TranscriptError && err.stage !== 'transcribe') throw err
        failures.push(`${side} side: ${(err as Error).message}`)
      }
    }
    job[side] = result
    onSide(side, result)
  }

  if (!job.caller && !job.lead) {
    throw new TranscriptError('transcribe', failures.join('; ') || 'no audio to transcribe')
  }
  if (looksGarbled([job.caller?.text ?? '', job.lead?.text ?? ''])) {
    throw new TranscriptError('garbled', 'the transcriber returned word salad instead of English')
  }

  const lines = [...toLines(job.caller, 'caller'), ...toLines(job.lead, 'lead')].sort((a, b) => a.start - b.start)
  if (lines.length === 0) throw new TranscriptError('no-speech', 'no speech was heard on either side')

  return {
    text: lines.map((l) => `[${l.speaker === 'caller' ? 'US' : 'THEM'}] ${l.text}`).join('\n'),
    lines,
    model: TRANSCRIBE_MODEL,
    processingSeconds: Math.round((performance.now() - startedAt) / 100) / 10,
    peak: Math.max(split.callerPeak, split.leadPeak),
    warning: failures.join('; ') || undefined,
  }
}
