import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { StatsOverview } from '../types'
import { CallbacksPanel } from './CallbacksPanel'

function formatHms(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—')

export function MetricsView() {
  const [stats, setStats] = useState<StatsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(14)
  const [callbacksOpen, setCallbacksOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setStats(await api.stats(days))
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [days])

  useEffect(() => {
    void load()
  }, [load])

  const maxCalls = Math.max(1, ...(stats?.byDay.map((d) => d.calls) ?? [1]))

  return (
    <div className="page">
      {error && <div className="error-box">{error}</div>}

      <div className="page-head">
        <h2>Activity</h2>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          style={{ width: 'auto' }}
        >
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
        </select>
        <button onClick={() => void load()}>Refresh</button>
      </div>

      {stats && (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="label">Calls</div>
              <div className="value">{stats.summary.calls}</div>
            </div>
            <div className="stat">
              <div className="label">Talked to a person</div>
              <div className="value">{stats.summary.talked}</div>
            </div>
            <div className="stat">
              <div className="label">Talk rate</div>
              <div className="value">{Math.round(stats.summary.talkRate * 100)}%</div>
            </div>
            <div className="stat">
              <div className="label">Voicemail</div>
              <div className="value">{stats.summary.voicemail}</div>
            </div>
            <div className="stat">
              <div className="label">Not reached</div>
              <div className="value">{stats.summary.notReached}</div>
            </div>
            {stats.summary.unlabeled > 0 && (
              <div className="stat" title="Someone or something picked up, but no outcome was chosen after the call">
                <div className="label">No outcome picked</div>
                <div className="value">{stats.summary.unlabeled}</div>
              </div>
            )}
            <div className="stat">
              <div className="label">Talk time (people only)</div>
              <div className="value">{formatHms(stats.summary.talkSeconds)}</div>
            </div>
            <div className="stat">
              <div className="label">Est. Twilio cost</div>
              <div className="value">${stats.summary.estimatedCostUsd}</div>
            </div>
            <div className="stat">
              <div className="label">Total leads</div>
              <div className="value">{stats.totalLeads}</div>
            </div>
          </div>

          {stats.inbound && (
            <div className="stat-row">
              <button
                type="button"
                className={`stat stat-toggle${callbacksOpen ? ' is-open' : ''}`}
                aria-expanded={callbacksOpen}
                aria-controls="callbacks-panel"
                onClick={() => setCallbacksOpen((open) => !open)}
                title={callbacksOpen ? 'Hide the list' : 'Show who called our number back'}
              >
                <div className="label">
                  Called us back <span className="stat-toggle-hint">{callbacksOpen ? 'Hide ▴' : 'Show ▾'}</span>
                </div>
                <div className="value">{stats.inbound.total}</div>
              </button>
              <div className="stat">
                <div className="label">AI answered</div>
                <div className="value">{stats.inbound.ai}</div>
              </div>
              <div className="stat">
                <div className="label">You answered</div>
                <div className="value">{stats.inbound.human}</div>
              </div>
              <div className="stat" title="Hung up while ringing, or the AI was off or over its daily limit">
                <div className="label">Missed</div>
                <div className="value">{stats.inbound.missed}</div>
              </div>
              <div className="stat">
                <div className="label">AI talk time</div>
                <div className="value">{formatHms(stats.inbound.aiSeconds)}</div>
              </div>
            </div>
          )}

          {stats.inbound && callbacksOpen && <CallbacksPanel days={days} />}

          <div className="card-section">
            <h4>Calls per day</h4>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Calls</th>
                  <th>Talked</th>
                  <th>Voicemail</th>
                  <th>Talk</th>
                  <th style={{ width: '40%' }} />
                </tr>
              </thead>
              <tbody>
                {stats.byDay.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No calls yet.
                    </td>
                  </tr>
                )}
                {stats.byDay.map((d) => (
                  <tr key={d.date}>
                    <td className="mono">{d.date}</td>
                    <td className="mono">{d.calls}</td>
                    <td className="mono">{d.talked}</td>
                    <td className="mono">{d.voicemail}</td>
                    <td className="mono">{formatHms(d.talkSeconds)}</td>
                    <td>
                      <div className="bar" style={{ width: `${(d.calls / maxCalls) * 100}%` }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="stat-row">
            <div className="card-section">
              <h4>Best hour to call</h4>
              <table>
                <thead>
                  <tr>
                    <th>Hour (lead time)</th>
                    <th>Calls</th>
                    <th>Talked</th>
                    <th>Voicemail</th>
                    <th>Talk rate</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byHour.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={5}>
                        No calls yet.
                      </td>
                    </tr>
                  )}
                  {stats.byHour.map((h) => (
                    <tr key={h.hour}>
                      <td className="mono">{String(h.hour).padStart(2, '0')}:00</td>
                      <td className="mono">{h.calls}</td>
                      <td className="mono">{h.talked}</td>
                      <td className="mono">{h.voicemail}</td>
                      <td className="mono">{pct(h.talked, h.calls)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card-section">
              <h4>Talk rate by attempt</h4>
              <table>
                <thead>
                  <tr>
                    <th>Attempt</th>
                    <th>Calls</th>
                    <th>Talked</th>
                    <th>Voicemail</th>
                    <th>Talk rate</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byAttempt.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={5}>
                        No calls yet.
                      </td>
                    </tr>
                  )}
                  {stats.byAttempt.map((a) => (
                    <tr key={a.attempt}>
                      <td className="mono">#{a.attempt}</td>
                      <td className="mono">{a.calls}</td>
                      <td className="mono">{a.talked}</td>
                      <td className="mono">{a.voicemail}</td>
                      <td className="mono">{pct(a.talked, a.calls)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="stat-row">
            <div className="card-section">
              <h4>Outcomes</h4>
              <table>
                <tbody>
                  {stats.byDisposition.length === 0 && (
                    <tr>
                      <td className="muted">No dispositions yet.</td>
                    </tr>
                  )}
                  {stats.byDisposition.map((d) => (
                    <tr key={d.disposition}>
                      <td>{d.disposition.replace(/_/g, ' ')}</td>
                      <td className="mono">{d.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card-section">
              <h4>Pipeline</h4>
              <table>
                <tbody>
                  {stats.byStatus.map((d) => (
                    <tr key={d.status}>
                      <td>{d.status}</td>
                      <td className="mono">{d.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card-section">
              <h4>By caller</h4>
              <table>
                <tbody>
                  {stats.byCaller.length === 0 && (
                    <tr>
                      <td className="muted">No calls yet.</td>
                    </tr>
                  )}
                  {stats.byCaller.map((d) => (
                    <tr key={d.username}>
                      <td>{d.username}</td>
                      <td className="mono">{d.calls} calls</td>
                      <td className="mono">{d.talked} talked</td>
                      <td className="mono">{formatHms(d.talkSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

    </div>
  )
}
