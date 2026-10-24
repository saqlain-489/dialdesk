import type { CallHistoryEntry, Lead } from '../types'
import { openingHook } from '../lib/callScript'
import { INBOUND_LABEL } from '../lib/inbound'
import { outcomeText } from '../lib/outcome'

function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function untilLabel(iso: string): string {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
  if (minutes <= 0) return 'due now'
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

export function LeadCard({
  lead,
  leadTimeZone,
  calls,
}: {
  lead: Lead
  leadTimeZone: string
  calls: CallHistoryEntry[]
}) {
  const localTime = new Intl.DateTimeFormat('en-US', {
    timeZone: leadTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).format(new Date())
  // An unverified hookSnippet is imported page text ("Just a moment..." from a bot check), so the
  // hook is the segment's first line instead.
  const hook = openingHook(lead)

  return (
    <div className="pane lead-card">
      <h3>{lead.businessName}</h3>
      <div className="lead-phone mono">{lead.phoneDisplay}</div>

      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <span className="badge">{localTime} their time</span>
        {lead.lane && <span className="badge purple">{lead.lane}</span>}
        {lead.attempts > 0 && <span className="badge yellow">{lead.attempts} attempts</span>}
        {lead.lastCalledAt && <span className="badge">last called {timeAgo(lead.lastCalledAt)}</span>}
        {lead.nextCallbackAt && (
          <span className="badge purple">callback {untilLabel(lead.nextCallbackAt)}</span>
        )}
        {lead.rating != null && (
          <span className="badge">
            ★ {lead.rating} ({lead.reviewCount ?? 0})
          </span>
        )}
        {lead.siteQualityScore != null && (
          <span className={`badge ${lead.siteQualityScore < 50 ? 'red' : 'green'}`}>
            site {lead.siteQualityScore}/100
          </span>
        )}
      </div>

      <div className="card-section">
        <h4>Opening hook · {hook.label}</h4>
        <div className="hook">{hook.line}</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {hook.check}
        </div>
      </div>

      {lead.siteIssues.length > 0 && (
        <div className="card-section">
          <h4>What the site check found</h4>
          <ul className="issue-list">
            {lead.siteIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card-section">
        <h4>Details</h4>
        <dl className="kv">
          {lead.askForName && (
            <>
              <dt>Ask for</dt>
              <dd>
                <strong>{lead.askForName}</strong>
                {lead.askForRole && <span className="muted"> · {lead.askForRole}</span>}
                {lead.askForNote && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    {lead.askForNote}
                  </div>
                )}
              </dd>
            </>
          )}
          {lead.ownerName && (
            <>
              <dt>Owner</dt>
              <dd>
                {lead.ownerName}
                {lead.ownerLabel && <span className="muted"> · {lead.ownerLabel}</span>}
              </dd>
            </>
          )}
          {lead.website && (
            <>
              <dt>Website</dt>
              <dd>
                <a href={lead.website} target="_blank" rel="noreferrer">
                  {lead.website}
                </a>
              </dd>
            </>
          )}
          {lead.bestEmail && (
            <>
              <dt>Email</dt>
              <dd>{lead.bestEmail}</dd>
            </>
          )}
          {lead.address && (
            <>
              <dt>Address</dt>
              <dd>{lead.address}</dd>
            </>
          )}
          {lead.category && (
            <>
              <dt>Category</dt>
              <dd>{lead.category}</dd>
            </>
          )}
          {lead.googleMapsUrl && (
            <>
              <dt>Maps</dt>
              <dd>
                <a href={lead.googleMapsUrl} target="_blank" rel="noreferrer">
                  Open in Google Maps
                </a>
              </dd>
            </>
          )}
        </dl>
      </div>

      {calls.length > 0 && (
        <div className="card-section">
          <h4>Call history</h4>
          <div className="stack">
            {calls.map((call) => (
              <div key={call.id} className="row" style={{ fontSize: 13, gap: 8 }}>
                {call.direction === 'inbound' ? (
                  <span className="badge purple">called us</span>
                ) : (
                  <span className="muted mono">#{call.attemptNumber ?? '?'}</span>
                )}
                <span>{new Date(call.startedAt).toLocaleString()}</span>
                <span className="spacer" />
                {call.direction === 'inbound' ? (
                  <span className={`badge ${call.handledBy === 'missed' ? 'red' : 'green'}`}>
                    {INBOUND_LABEL[call.handledBy ?? 'missed']} {call.duration}s
                  </span>
                ) : call.answeredAt ? (
                  <span className="badge green">answered {call.duration}s</span>
                ) : (
                  <span className="badge">{call.dialStatus ?? 'no answer'}</span>
                )}
                {call.disposition && (
                  <span className="badge yellow">{outcomeText(call.disposition, call.dispositionLabel)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {lead.notes.length > 0 && (
        <div className="card-section">
          <h4>Notes</h4>
          <div className="stack">
            {lead.notes
              .slice()
              .reverse()
              .map((note, i) => (
                <div key={i}>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {note.author} · {new Date(note.at).toLocaleString()}
                  </div>
                  <div>{note.body}</div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
