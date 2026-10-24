/// <reference lib="webworker" />
import { pipeline, env as transformersEnv } from '@huggingface/transformers'

// Setup-page diagnostics only: runs one clip on a chosen backend; calls never use this worker.
transformersEnv.allowLocalModels = false

export type DiagnoseRequest = { device: 'webgpu' | 'wasm'; dtype: 'q8' | 'fp32'; model: string; audio: Float32Array }

export type DiagnoseResponse =
  | { type: 'progress'; stage: string; pct: number | null }
  | { type: 'done'; text: string; loadSeconds: number; runSeconds: number }
  | { type: 'error'; message: string }

type Asr = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string }>

function post(message: DiagnoseResponse) {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(message)
}

self.onmessage = async (event: MessageEvent<DiagnoseRequest>) => {
  const { device, dtype, model, audio } = event.data
  try {
    const t0 = performance.now()
    const asr = (await pipeline('automatic-speech-recognition', model, {
      device,
      dtype,
      progress_callback: (p: { status?: string; progress?: number }) =>
        post({
          type: 'progress',
          stage: p.status === 'progress' ? 'downloading model' : (p.status ?? 'loading'),
          pct: typeof p.progress === 'number' ? Math.round(p.progress) : null,
        }),
    })) as unknown as Asr
    const t1 = performance.now()
    post({ type: 'progress', stage: 'transcribing', pct: null })
    const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, temperature: 0 })
    post({
      type: 'done',
      text: out.text.trim(),
      loadSeconds: Math.round((t1 - t0) / 100) / 10,
      runSeconds: Math.round((performance.now() - t1) / 100) / 10,
    })
  } catch (err) {
    post({ type: 'error', message: (err as Error).message })
  }
}
