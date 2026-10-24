import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { callerName, formatClock, TRANSCRIPT_FAILED_TEXT } from '../lib/callFormat'
import { INBOUND_LABEL, summaryRows } from '../lib/inbound'
import { outcomeText, outcomeTone } from '../lib/outcome'
import type { LeadDetail, TranscriptDetail, TranscriptLine, TranscriptRow } from '../types'
import { Highlight } from './Highlight'
import { LeadCard } from './LeadCard'

let leadTimeZone: Promise<string> | null = null
// The lead's clock on the card comes from the server's call-window zone, read once per page load.
function loadLeadTimeZone(): Promise<string> {
  leadTimeZone ??= api
    .health()
    .then((h) => h.callWindow?.leadTimeZone ?? 'America/New_York')
    .catch(() => 'America/New_York')
  return leadTimeZone
}

export function TranscriptDrawer({
  id,
  row,
  term,
  position,
  total,
  fetchDetail,
  onClose,
  onPrev,
  onNext,
}: {
  id: string
  row: TranscriptRow | null
  term?: string
  position: number | null
  total: number
  fetchDetail: (id: string) => Promise<TranscriptDetail>
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
}) {
  const [detail, setDetail] = useState<TranscriptDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [view, setView] = useState<'transcript' | 'lead'>('transcript')
  const [lead, setLead] = useState<(LeadDetail & { timeZone: string }) | null>(null)
  const [leadError, setLeadError] = useState<string | null>(null)
  const wantedLead = useRef<string | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let stale = false
    setDetail(null)
    setError(null)
    setCopied(false)
    setView('transcript')
    fetchDetail(id)
      .then((d) => {
        if (!stale) setDetail(d)
      })
      .catch((err) => {
        if (!stale) setError((err as Error).message)
      })
    bodyRef.current?.scrollTo({ top: 0 })
    return () => {
      stale = true
    }
  }, [id, fetchDetail])

  // Focus returns to whatever opened the drawer (the table row) when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => opener?.focus?.()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      const typing = (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT'
      if (typing) return
      if ((e.key === 'ArrowDown' || e.key === 'j') && onNext) {
        e.preventDefault()
        onNext()
      }
      if ((e.key === 'ArrowUp' || e.key === 'k') && onPrev) {
        e.preventDefault()
        onPrev()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNext, onPrev])

  // The list row is shown instantly; the full record fills in when it arrives.
  const head = detail ?? row
  const inbound = head?.direction === 'inbound'
  const speakerName = (speaker: TranscriptLine['speaker']) =>
    speaker === 'lead' ? 'Them' : speaker === 'ai' ? 'Ava (AI)' : detail?.username ? callerName(detail.username) : 'Us'

  async function openLead() {
    const leadId = detail?.leadId
    if (!leadId) return
    setView('lead')
    bodyRef.current?.scrollTo({ top: 0 })
    if (lead?.lead.id === leadId) return
    wantedLead.current = leadId
    setLead(null)
    setLeadError(null)
    try {
      const [data, timeZone] = await Promise.all([api.leadDetail(leadId), loadLeadTimeZone()])
      if (wantedLead.current === leadId) setLead({ ...data, timeZone })
    } catch (err) {
      if (wantedLead.current === leadId) setLeadError((err as Error).message)
    }
  }

  async function copy() {
    if (!detail?.transcript) return
    const header = `${detail.businessName ?? 'Unknown'} · ${new Date(detail.startedAt).toLocaleString()}`
    await navigator.clipboard.writeText(`${header}\n\n${detail.transcript.text}`)
    setCopied(true)
  }

  const leadView = (
    <>
      {leadError && <div className="error-box">{leadError}</div>}
      {!lead && !leadError && <div className="muted">Loading lead…</div>}
      {lead && (
        <>
          <div className="row drawer-lead-status">
            <span className="badge">{lead.lead.status}</span>
            {lead.lead.doNotCall && <span className="badge red">do not call</span>}
            {lead.lead.archivedAt && <span className="badge red">archived</span>}
          </div>
          <LeadCard lead={lead.lead} leadTimeZone={lead.timeZone} calls={lead.calls} />
        </>
      )}
    </>
  )

  const transcriptView = (
    <>
      {error && <div className="error-box">{error}</div>}
      {!detail && !error && <div className="muted">Loading transcript…</div>}

      {detail && summaryRows(detail.aiSummary).length > 0 && (
        <dl className="kv drawer-summary">
          {summaryRows(detail.aiSummary).map(([label, value]) => (
            <div key={label} style={{ display: 'contents' }}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {detail && !detail.transcript && (
        <div className="notice">
          <strong>No transcript.</strong>{' '}
          {detail.error
            ? `${TRANSCRIPT_FAILED_TEXT[detail.error.stage] ?? detail.error.stage}${detail.error.message ? ` (${detail.error.message})` : ''}.`
            : 'This call was not transcribed.'}
        </div>
      )}

      {detail?.transcript && (
        <div className="conversation">
          {detail.transcript.lines.length > 0 ? (
            detail.transcript.lines.map((line, i) => {
              const ours = line.speaker !== 'lead'
              return (
                <div key={i} className={`bubble-row${ours ? ' ours' : ''}`}>
                  <div className="bubble">
                    <div className="bubble-meta">
                      {speakerName(line.speaker)} · {formatClock(line.start)}
                    </div>
                    <Highlight text={line.text} term={term} />
                  </div>
                </div>
              )
            })
          ) : (
            <pre className="conversation-raw">{detail.transcript.text}</pre>
          )}
        </div>
      )}
    </>
  )

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Call transcript">
        <div className="drawer-head">
          <div className="drawer-title-row">
            <div className="drawer-title">
              <h3>{head?.businessName ?? (inbound ? 'Unknown caller' : 'Loading…')}</h3>
              <div className="muted" style={{ fontSize: 12 }}>
                {[head?.phone, detail?.place].filter(Boolean).join(' · ')}
              </div>
            </div>
            <button ref={closeRef} className="drawer-close" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">
              ✕
            </button>
          </div>

          {head && (
            <div className="drawer-meta">
              <span>{new Date(head.startedAt).toLocaleString()}</span>
              <span>{inbound ? `They called us · ${INBOUND_LABEL[head.handledBy ?? 'ai']}` : `${callerName(head.username)} · attempt #${head.attemptNumber ?? '?'}`}</span>
              <span>{formatClock(head.duration)}</span>
              {head.disposition && (
                <span className={`badge ${outcomeTone(head.disposition)}`}>
                  {outcomeText(head.disposition, head.dispositionLabel)}
                </span>
              )}
            </div>
          )}

          <div className="drawer-actions">
            <button onClick={onPrev} disabled={!onPrev} title="Previous call (↑ or K)">
              ‹ Prev
            </button>
            <button onClick={onNext} disabled={!onNext} title="Next call (↓ or J)">
              Next ›
            </button>
            {position && (
              <span className="muted" style={{ fontSize: 12 }}>
                {position} of {total.toLocaleString()}
              </span>
            )}
            <span className="spacer" />
            {view === 'lead' ? (
              <button onClick={() => setView('transcript')}>‹ Transcript</button>
            ) : (
              <>
                {detail?.leadId && (
                  <button onClick={() => void openLead()} title="The lead's details, notes and call history">
                    Open lead
                  </button>
                )}
                <button onClick={() => void copy()} disabled={!detail?.transcript}>
                  {copied ? 'Copied' : 'Copy text'}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="drawer-body" ref={bodyRef}>
          {view === 'lead' ? leadView : transcriptView}
        </div>

        {detail && (
          <div className="drawer-foot">
            {detail.transcript &&
              (inbound
                ? 'Transcribed by the voice service'
                : `${detail.transcript.model ?? 'Whisper'}${detail.transcript.processingSeconds ? ` · ${detail.transcript.processingSeconds}s to transcribe` : ''}`)}
            {detail.quality && (
              <>
                {detail.transcript && ' · '}
                {detail.quality.avgMos !== null && `MOS ${detail.quality.avgMos}`}
                {detail.quality.outLossPct !== null && ` · our voice lost ${detail.quality.outLossPct}%`}
                {detail.quality.voiceDb !== null &&
                  ` · our voice ${detail.quality.voiceDb} dBFS (gaps ${detail.quality.voiceFloorDb}, peak ${detail.quality.voicePeakDb ?? '–'})`}
                {detail.quality.mic && ` · mic: ${detail.quality.mic}`}
              </>
            )}
          </div>
        )}
      </aside>
    </>
  )
}
