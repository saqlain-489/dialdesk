/// <reference lib="webworker" />
import { pipeline, env as transformersEnv } from '@huggingface/transformers'

// Models stream from the Hugging Face CDN on first use and are then served from the
// browser cache. Nothing is bundled, and — importantly — no audio is ever uploaded:
// the whole pipeline runs on the caller's machine.
transformersEnv.allowLocalModels = false

type Chunk = { timestamp: [number, number | null]; text: string }
export type AsrResult = { text: string; chunks?: Chunk[] }
type Asr = (audio: Float32Array, options: Record<string, unknown>) => Promise<AsrResult>

export type TranscribeRequest =
  | { id: string; kind: 'preload'; model: string }
  | { id: string; kind: 'channel'; model: string; audio: Float32Array }

export type TranscribeResponse =
  | { id: string; type: 'progress'; stage: string; pct: number | null }
  | { id: string; type: 'done'; result: AsrResult | null; model: string }
  | { id: string; type: 'error'; stage: string; message: string }

let asrPromise: Promise<Asr> | null = null
let loadedModel: string | null = null

function post(message: TranscribeResponse) {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(message)
}

// CPU only: whisper q8 on WebGPU returns the same word salad for any audio, ~15x slower than
// real time (reproduced, see docs/in-browser-transcription.md).
function getAsr(model: string, id: string): Promise<Asr> {
  if (asrPromise && loadedModel === model) return asrPromise

  loadedModel = model
  asrPromise = pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: (p: { status?: string; progress?: number }) => {
      post({
        id,
        type: 'progress',
        stage: p.status === 'progress' ? 'downloading model' : (p.status ?? 'loading'),
        pct: typeof p.progress === 'number' ? Math.round(p.progress) : null,
      })
    },
  }) as unknown as Promise<Asr>
  // A failed load must not be cached, or every later call fails the same way.
  asrPromise.catch(() => {
    asrPromise = null
  })
  return asrPromise
}

// Phone audio is 8 kHz upsampled to 16 kHz and full of hesitations. Long chunks with
// generous stride keep Whisper from hallucinating filler across silence, which is the
// dominant failure mode on phone audio.
const DECODE_OPTIONS = {
  chunk_length_s: 30,
  stride_length_s: 5,
  return_timestamps: true,
  temperature: 0,
  no_repeat_ngram_size: 4,
  condition_on_previous_text: false,
}

self.onmessage = async (event: MessageEvent<TranscribeRequest>) => {
  const request = event.data
  const { id, model } = request

  let asr: Asr
  try {
    asr = await getAsr(model, id)
  } catch (err) {
    post({ id, type: 'error', stage: 'model-load', message: (err as Error).message })
    return
  }
  if (request.kind === 'preload') {
    post({ id, type: 'done', result: null, model })
    return
  }

  try {
    post({ id, type: 'progress', stage: 'transcribing', pct: null })
    const first = await asr(request.audio, DECODE_OPTIONS)
    // Timestamped decoding sometimes emits nothing on short or quiet clips; plain decoding still gets the words.
    const result = first.text.trim() ? first : await asr(request.audio, { chunk_length_s: 30, stride_length_s: 5 })
    post({ id, type: 'done', result, model })
  } catch (err) {
    post({ id, type: 'error', stage: 'transcribe', message: (err as Error).message })
  }
}
