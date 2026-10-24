import { useState } from 'react'
import type { PreflightResult } from '../hooks/useTwilioDevice'

// A caller far from Twilio's Ashburn edge sees ~250ms no matter what, so the
// thresholds here are about "is today's connection usable", not "is it good".
function verdict(result: PreflightResult): { text: string; tone: string } {
  const mos = result.mos
  if (mos == null) return { text: 'Completed — no MOS score returned', tone: '' }
  if (mos >= 4) return { text: 'Good — audio should be clear', tone: 'green' }
  if (mos >= 3.5) return { text: 'Acceptable — expect some talk-over', tone: 'yellow' }
  return { text: 'Poor — fix your connection before calling', tone: 'red' }
}

export function PreflightPanel({
  runPreflight,
}: {
  runPreflight: () => Promise<PreflightResult>
}) {
  const [result, setResult] = useState<PreflightResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  async function run() {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      setResult(await runPreflight())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="card-section">
      <h4>Connection test</h4>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Run this before a shift. It places a short test call to Twilio and measures your line.
      </p>
      <button onClick={run} disabled={running}>
        {running ? 'Testing… (about 15s)' : 'Run connection test'}
      </button>

      {error && (
        <div className="error-box" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12 }}>
          <span className={`badge ${verdict(result).tone}`}>{verdict(result).text}</span>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Round trip</dt>
            <dd className="mono">{result.rttMs != null ? `${Math.round(result.rttMs)} ms` : '—'}</dd>
            <dt>Jitter</dt>
            <dd className="mono">
              {result.jitterMs != null ? `${result.jitterMs.toFixed(1)} ms` : '—'}
            </dd>
            <dt>MOS</dt>
            <dd className="mono">{result.mos != null ? result.mos.toFixed(2) : '—'}</dd>
            <dt>Quality</dt>
            <dd>{result.quality}</dd>
          </dl>
        </div>
      )}
    </div>
  )
}
