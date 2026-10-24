import { useEffect, useRef, useState } from 'react'
import { preloadTranscriber, TRANSCRIBE_MODEL, transcribeSamples, type TranscriptionStage } from '../lib/transcription'
import type { DiagnoseRequest, DiagnoseResponse } from '../workers/diagnose.worker'

// transformers.js's own test clip, so every machine is judged on identical audio.
const CLIP_URL = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav'
const EXPECTED = 'ask not what your country can do for you'

type Env = {
  os: string
  chrome: string
  gpu: string
  cores: number | null
  memoryGb: number | null
}

type Run = { label: string; text: string; loadSeconds: number; runSeconds: number; pass: boolean } | { label: string; error: string }

function osName(ua: string): string {
  if (/Windows/.test(ua)) return 'Windows'
  if (/Android/.test(ua)) return 'Android'
  if (/iPhone|iPad/.test(ua)) return 'iOS'
  if (/Mac OS X/.test(ua)) return 'macOS'
  if (/Linux/.test(ua)) return 'Linux'
  return 'unknown'
}

async function readEnv(): Promise<Env> {
  const nav = navigator as Navigator & {
    gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> }
    deviceMemory?: number
  }
  let gpu = 'none (this browser does not expose WebGPU)'
  if (nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter()
      const info = adapter?.info
      gpu = adapter
        ? `available: ${[info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ') || 'unnamed adapter'}`
        : 'none (no adapter)'
    } catch (err) {
      gpu = `error: ${(err as Error).message}`
    }
  }
  return {
    os: osName(navigator.userAgent),
    chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? 'not Chrome',
    gpu,
    cores: navigator.hardwareConcurrency ?? null,
    memoryGb: nav.deviceMemory ?? null,
  }
}

async function loadClip(): Promise<Float32Array> {
  const bytes = await (await fetch(CLIP_URL)).arrayBuffer()
  const decoded = await new OfflineAudioContext(1, 16_000, 16_000).decodeAudioData(bytes)
  return decoded.getChannelData(0).slice()
}

const passes = (text: string) => text.toLowerCase().replace(/[^a-z ]/g, '').includes(EXPECTED)

function runOnGpu(audio: Float32Array, onStage: (stage: string) => void): Promise<{ text: string; loadSeconds: number; runSeconds: number }> {
  const worker = new Worker(new URL('../workers/diagnose.worker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<DiagnoseResponse>) => {
      const message = event.data
      if (message.type === 'progress') {
        onStage(`${message.stage}${message.pct !== null ? ` ${message.pct}%` : ''}`)
        return
      }
      worker.terminate()
      if (message.type === 'done') resolve(message)
      else reject(new Error(message.message))
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || 'diagnostics worker crashed'))
    }
    const request: DiagnoseRequest = { device: 'webgpu', dtype: 'q8', model: TRANSCRIBE_MODEL, audio }
    worker.postMessage(request, [audio.buffer as ArrayBuffer])
  })
}

export function TranscriberCheckPanel() {
  const [env, setEnv] = useState<Env | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [stage, setStage] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const clip = useRef<Float32Array | null>(null)

  useEffect(() => {
    void readEnv().then(setEnv)
  }, [])

  async function withClip(label: string, work: (audio: Float32Array) => Promise<Omit<Extract<Run, { text: string }>, 'label' | 'pass'>>) {
    setWorking(true)
    try {
      setEnv(await readEnv())
      setStage('downloading test clip')
      clip.current ??= await loadClip()
      const result = await work(clip.current.slice())
      setRuns((previous) => [...previous, { label, ...result, pass: passes(result.text) }])
    } catch (err) {
      setRuns((previous) => [...previous, { label, error: (err as Error).message }])
    } finally {
      setStage(null)
      setWorking(false)
    }
  }

  const onProgress = (s: TranscriptionStage | null) =>
    setStage(s ? `${s.stage}${s.pct !== null ? ` ${s.pct}%` : ''}` : null)

  const checkCalls = () =>
    withClip('Calls (CPU)', async (audio) => {
      const t0 = performance.now()
      await preloadTranscriber(onProgress)
      const t1 = performance.now()
      const result = await transcribeSamples('transcriber-check', audio, onProgress)
      return {
        text: result?.text.trim() ?? '',
        loadSeconds: Math.round((t1 - t0) / 100) / 10,
        runSeconds: Math.round((performance.now() - t1) / 100) / 10,
      }
    })

  const checkOldGpu = () => withClip('Old setting (graphics chip, q8)', (audio) => runOnGpu(audio, setStage))

  const report = env
    ? [
        `os ${env.os} · chrome ${env.chrome} · cores ${env.cores ?? '?'} · memory ${env.memoryGb ?? '?'} GB`,
        `webgpu ${env.gpu}`,
        ...runs.map((r) =>
          'error' in r
            ? `${r.label}: ERROR ${r.error}`
            : `${r.label}: ${r.pass ? 'PASS' : 'FAIL'} · load ${r.loadSeconds}s · run ${r.runSeconds}s (11 s clip) · "${r.text.slice(0, 120)}"`,
        ),
      ].join('\n')
    : ''

  return (
    <div className="card-section">
      <h4>Transcriber check</h4>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Runs an 11-second test clip through the same transcriber calls use and checks the words come out right.
        Use it on any computer whose transcripts look wrong; copy the report below when asking for help.
      </p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button onClick={() => void checkCalls()} disabled={working}>
          Check transcriber
        </button>
        {env?.gpu.startsWith('available') && (
          <button
            onClick={() => void checkOldGpu()}
            disabled={working}
            title="The graphics-chip (WebGPU) setting transcription used to run on. Expected to fail; it can take a few minutes."
          >
            Test old graphics-chip setting
          </button>
        )}
      </div>

      {stage && (
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          {stage}
        </div>
      )}

      {runs.map((run, i) => (
        <div key={i} style={{ marginTop: 10 }}>
          {'error' in run ? (
            <div className="error-box">
              {run.label}: {run.error}
            </div>
          ) : (
            <>
              <span className={`badge ${run.pass ? 'green' : 'red'}`}>
                {run.label}: {run.pass ? 'PASS' : 'FAIL'} · {run.runSeconds}s for 11s of audio
              </span>
              <div style={{ marginTop: 6, fontSize: 13 }}>“{run.text}”</div>
            </>
          )}
        </div>
      ))}

      {report && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 12 }}>{report}</pre>}
    </div>
  )
}
