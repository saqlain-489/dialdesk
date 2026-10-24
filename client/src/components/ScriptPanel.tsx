import { useEffect, useState } from 'react'
import { defaultMode, resolveScript, type CallMode } from '../lib/callScript'
import type { Lead } from '../types'

const MODES: Array<{ id: CallMode; label: string; hint: string }> = [
  { id: 'cold', label: 'Cold', hint: 'First real conversation' },
  { id: 'warm', label: 'Called back', hint: 'They called us, or asked us to call back' },
  { id: 'followup', label: 'Follow-up', hint: 'They asked for something and it is ready' },
]

export function ScriptPanel({
  lead,
  callerName,
  companyName,
  callbackNumber,
  calledUs,
}: {
  lead: Lead
  callerName: string
  companyName: string
  callbackNumber: string | null
  calledUs: boolean
}) {
  const [showObjections, setShowObjections] = useState(false)
  const [showExtras, setShowExtras] = useState(false)
  const [modeOverride, setModeOverride] = useState<CallMode | null>(null)

  useEffect(() => setModeOverride(null), [lead.id])

  const mode = modeOverride ?? defaultMode(lead, calledUs)
  const script = resolveScript(lead, { callerName, companyName, mode, callbackNumber })

  return (
    <div className="pane script-pane">
      <div className="row" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Script</h2>
        <span className="badge red">{script.label}</span>
        {mode === 'cold' && (
          <span className="badge purple" title="A = permission first, B = problem first. Alternates by lead.">
            Opener {script.variant}
          </span>
        )}
      </div>

      <div className="row" style={{ gap: 6, marginTop: 10 }}>
        {MODES.map((m) => (
          <button
            key={m.id}
            title={m.hint}
            className={mode === m.id ? 'primary' : undefined}
            style={{ flex: 1, padding: '4px 8px', fontSize: 12 }}
            onClick={() => setModeOverride(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode !== 'followup' && (
        <div className="card-section">
          <h4>0 · Before you dial</h4>
          <div className="muted" style={{ fontSize: 12 }}>
            {script.check}
          </div>
        </div>
      )}

      <div className="card-section">
        <h4>1 · First 10 seconds</h4>
        <div className="stack">
          {script.opener.map((line, i) => (
            <Line key={i} text={line} />
          ))}
        </div>
      </div>

      {mode !== 'followup' && (
        <>
          <div className="card-section">
            <h4>2 · The one problem</h4>
            <div className="hook">{script.firstLine}</div>
            <div className="stack" style={{ marginTop: 8 }}>
              {script.next.map((line, i) => (
                <Line key={i} text={line} />
              ))}
            </div>
            {script.secondaryIssues.length > 0 && (
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                Also found (mention only if they ask what else): {script.secondaryIssues.join(', ')}
              </div>
            )}
          </div>

          <div className="card-section">
            <h4>3 · Small yes, then stop talking</h4>
            <div className="hook">{script.microYes}</div>
          </div>
        </>
      )}

      <div className="card-section">
        <h4>{mode === 'followup' ? '2' : '4'} · The ask</h4>
        <div className="stack">
          {script.ask.map((line, i) => (
            <Line key={i} text={line} />
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          If they ask why you called: {script.whyCall.join(' ')}
        </div>
      </div>

      <div className="card-section">
        <h4>{mode === 'followup' ? '3' : '5'} · On a yes</h4>
        <div className="stack">
          {script.close.map((line, i) => (
            <Line key={i} text={line} />
          ))}
        </div>
      </div>

      <button style={{ width: '100%' }} onClick={() => setShowObjections((v) => !v)}>
        {showObjections ? 'Hide' : 'Show'} objections ({script.objections.length})
      </button>

      {showObjections && (
        <div className="card-section">
          <div className="stack">
            {script.objections.map((objection, i) => (
              <div key={i} style={{ borderTop: i ? '1px solid var(--line, #2a2a2a)' : undefined, paddingTop: i ? 10 : 0 }}>
                <div className="badge yellow" style={{ marginBottom: 6 }}>
                  “{objection.they}”
                </div>
                <div className="stack">
                  {objection.you.map((line, j) => (
                    <Line key={j} text={line} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            Polite exit: "No problem. Thanks for your time. Have a good one."
          </div>
        </div>
      )}

      <button style={{ width: '100%', marginTop: 8 }} onClick={() => setShowExtras((v) => !v)}>
        {showExtras ? 'Hide' : 'Show'} voicemail · gatekeeper · bad line · never say
      </button>

      {showExtras && (
        <>
          <div className="card-section">
            <h4>Voicemail (about 15 seconds)</h4>
            <div className="hook">{script.voicemail}</div>
          </div>

          <div className="card-section">
            <h4>If someone else answers</h4>
            <div className="stack">
              {script.gatekeeper.map((line, i) => (
                <Line key={i} text={line} />
              ))}
            </div>
          </div>

          <div className="card-section">
            <h4>If the line breaks up</h4>
            <ul className="issue-list">
              {script.lineBreaks.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </div>

          <div className="card-section">
            <h4>Never say</h4>
            <ul className="issue-list">
              {script.neverSay.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

// Parenthetical lines are stage directions, not words to read aloud — dimming them
// stops the caller reading "(wait for the yes)" to a prospect, which does happen.
function Line({ text }: { text: string }) {
  const isDirection = text.trimStart().startsWith('(') || text.trimStart().startsWith('>>>')
  if (isDirection) {
    return (
      <div className="muted" style={{ fontSize: 12, fontStyle: 'italic' }}>
        {text}
      </div>
    )
  }
  return <div style={{ lineHeight: 1.5 }}>{text}</div>
}
