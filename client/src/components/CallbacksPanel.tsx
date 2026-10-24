import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { callerName, formatClock, formatWhen } from '../lib/callFormat'
import { INBOUND_LABEL, inboundReasonText } from '../lib/inbound'
import { outcomeText, outcomeTone } from '../lib/outcome'
import type { CallbackPage, CallbackQuery, CallbackRow, CallbackSort, InboundHandler, TranscriptDetail } from '../types'
import { Highlight } from './Highlight'
import { Pager } from './Pager'
import { TranscriptDrawer } from './TranscriptDrawer'

const COLUMNS: { key: CallbackSort | null; label: string; className: string; title?: string }[] = [
  { key: 'startedAt', label: 'When', className: 'cb-when', title: 'Your time, then the lead’s time' },
  { key: 'business', label: 'Who called', className: 'cb-who' },
  { key: 'handledBy', label: 'Answered by', className: 'cb-handled' },
  { key: 'duration', label: 'Length', className: 'cb-length num' },
  { key: null, label: 'Our call before it', className: 'cb-before', title: 'Our last call to this lead before they rang back' },
  { key: 'status', label: 'Lead status', className: 'cb-status' },
  { key: null, label: 'What they wanted', className: 'cb-wanted' },
]

const HANDLED_TONE: Record<InboundHandler, string> = { ai: 'purple', human: 'green', missed: 'red' }

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 60) return `${Math.max(minutes, 0)}m ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 1440)}d ago`
}

function gap(fromIso: string, toIso: string): string {
  const minutes = Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000)
  if (minutes < 60) return `${minutes} min`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / 1440)} days`
}

export function CallbacksPanel({ days }: { days: number }) {
  const [query, setQuery] = useState<CallbackQuery>({ sort: 'startedAt', dir: 'desc', limit: 10, offset: 0, days: String(days) })
  const [searchText, setSearchText] = useState('')
  const [page, setPage] = useState<CallbackPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const requestSeq = useRef(0)
  const openAfterLoad = useRef<'first' | 'last' | null>(null)
  const details = useRef(new Map<string, TranscriptDetail>())

  // Follows the page's period so the list matches the tile's count.
  useEffect(() => {
    setQuery((q) => (q.days === String(days) ? q : { ...q, days: String(days), offset: 0 }))
  }, [days])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = searchText.trim()
      setQuery((q) => ((q.search ?? '') === search ? q : { ...q, search, offset: 0 }))
    }, 300)
    return () => window.clearTimeout(timer)
  }, [searchText])

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const data = await api.callbacks(query)
      if (seq !== requestSeq.current) return
      setPage(data)
      setError(null)
      if (openAfterLoad.current && data.rows.length) {
        setOpenId(openAfterLoad.current === 'first' ? data.rows[0]!.id : data.rows[data.rows.length - 1]!.id)
      }
      openAfterLoad.current = null
    } catch (err) {
      if (seq === requestSeq.current) setError((err as Error).message)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [query])

  useEffect(() => {
    void load()
  }, [load])

  const update = (patch: Partial<CallbackQuery>) => setQuery((q) => ({ ...q, ...patch, offset: 0 }))

  const sortBy = (key: CallbackSort) =>
    setQuery((q) => ({
      ...q,
      sort: key,
      dir: q.sort === key ? (q.dir === 'asc' ? 'desc' : 'asc') : key === 'business' || key === 'status' ? 'asc' : 'desc',
      offset: 0,
    }))

  const clearFilters = () => {
    setSearchText('')
    setQuery((q) => ({ ...q, search: '', handledBy: '', who: '', days: String(days), offset: 0 }))
  }

  const fetchDetail = useCallback(async (id: string) => {
    const cached = details.current.get(id)
    if (cached) return cached
    const detail = await api.transcript(id)
    details.current.set(id, detail)
    return detail
  }, [])

  const rows = page?.rows ?? []
  const total = page?.total ?? 0
  const openIndex = rows.findIndex((r) => r.id === openId)
  const hasPrev = openIndex > 0 || query.offset > 0
  const hasNext = (openIndex >= 0 && openIndex < rows.length - 1) || query.offset + query.limit < total

  const step = (delta: 1 | -1) => {
    const target = openIndex + delta
    if (target >= 0 && target < rows.length) {
      setOpenId(rows[target]!.id)
      return
    }
    if (delta === 1 && query.offset + query.limit < total) {
      openAfterLoad.current = 'first'
      setQuery((q) => ({ ...q, offset: q.offset + q.limit }))
    } else if (delta === -1 && query.offset > 0) {
      openAfterLoad.current = 'last'
      setQuery((q) => ({ ...q, offset: Math.max(0, q.offset - q.limit) }))
    }
  }

  const activeFilters =
    [query.search, query.handledBy, query.who].filter(Boolean).length + (query.days !== String(days) ? 1 : 0)

  return (
    <section className="card-section callbacks-panel" id="callbacks-panel">
      <div className="callbacks-head">
        <h4>Who called us back</h4>
        {page && <span className="badge">{total.toLocaleString()}</span>}
        {loading && page && <span className="muted" style={{ fontSize: 12 }}>Updating…</span>}
        <span className="spacer" />
        <button onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      <div className="transcript-toolbar">
        <input
          type="search"
          className="toolbar-search"
          placeholder="Search business, owner, phone, what they said or asked for…"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <select value={query.handledBy ?? ''} onChange={(e) => update({ handledBy: e.target.value })} title="Answered by">
          <option value="">Anyone answered</option>
          <option value="ai">AI answered</option>
          <option value="human">You answered</option>
          <option value="missed">Missed</option>
        </select>
        <select value={query.who ?? ''} onChange={(e) => update({ who: e.target.value })} title="Who">
          <option value="">All callers</option>
          <option value="lead">Our leads only</option>
          <option value="unknown">Not a lead</option>
          <option value="test">Test calls</option>
        </select>
        <select value={query.days ?? ''} onChange={(e) => update({ days: e.target.value })} title="Period">
          <option value="1">Last 24 hours</option>
          <option value="7">Last 7 days</option>
          <option value="14">Last 14 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="">All time</option>
        </select>
        {activeFilters > 0 && (
          <button className="toolbar-clear" onClick={clearFilters}>
            Clear filters ({activeFilters})
          </button>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className={`table-wrap callbacks-wrap${loading && page ? ' is-loading' : ''}`}>
        <table className="data-table callbacks-table">
          <colgroup>
            {COLUMNS.map((c) => (
              <col key={c.label} className={c.className} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((col) => {
                if (!col.key) {
                  return (
                    <th key={col.label} className={`${col.className} th-plain`} title={col.title}>
                      {col.label}
                    </th>
                  )
                }
                const key = col.key
                const sorted = query.sort === key
                return (
                  <th
                    key={col.label}
                    className={col.className}
                    aria-sort={sorted ? (query.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    title={col.title}
                  >
                    <button className={`sort-btn${sorted ? ' is-sorted' : ''}`} onClick={() => sortBy(key)}>
                      {col.label}
                      <span className="sort-arrow" aria-hidden>
                        {sorted ? (query.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {!page &&
              loading &&
              Array.from({ length: 3 }, (_, i) => (
                <tr key={i} className="skeleton-row">
                  {COLUMNS.map((c) => (
                    <td key={c.label}>
                      <span className="skeleton" />
                    </td>
                  ))}
                </tr>
              ))}
            {rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                term={query.search}
                leadTimeZone={page?.leadTimeZone ?? 'America/New_York'}
                open={row.id === openId}
                onOpen={() => setOpenId(row.id)}
              />
            ))}
          </tbody>
        </table>

        {page && rows.length === 0 && (
          <div className="table-empty">
            {activeFilters > 0 ? (
              <>
                <div>Nothing matches these filters.</div>
                <button onClick={clearFilters}>Clear filters</button>
              </>
            ) : (
              <div>Nobody has called our number back in this period.</div>
            )}
          </div>
        )}
      </div>

      <Pager
        total={total}
        offset={query.offset}
        limit={query.limit}
        pageSizes={[10, 25, 50]}
        onChange={({ offset, limit }) => setQuery((q) => ({ ...q, offset, limit }))}
      />

      {openId && (
        <TranscriptDrawer
          id={openId}
          row={null}
          term={query.search}
          position={openIndex >= 0 ? query.offset + openIndex + 1 : null}
          total={total}
          fetchDetail={fetchDetail}
          onClose={() => setOpenId(null)}
          onPrev={hasPrev ? () => step(-1) : undefined}
          onNext={hasNext ? () => step(1) : undefined}
        />
      )}
    </section>
  )
}

function Row({
  row,
  term,
  leadTimeZone,
  open,
  onOpen,
}: {
  row: CallbackRow
  term?: string
  leadTimeZone: string
  open: boolean
  onOpen: () => void
}) {
  const s = row.aiSummary
  const name = row.lead?.businessName ?? s?.business ?? (row.isTest ? 'Test call' : 'Unknown caller')
  const person = row.lead?.ownerName ?? s?.name
  const leadTime = new Date(row.startedAt).toLocaleString(undefined, {
    timeZone: leadTimeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
  const reason = inboundReasonText(row.reason)
  const last = row.lastOutbound
  const wanted = [s?.reason, s?.bestTime && `Call back: ${s.bestTime}`, s?.callbackNumber && `Number: ${s.callbackNumber}`, s?.email, s?.notes]
    .filter(Boolean)
    .join(' · ')

  return (
    <tr
      className={open ? 'is-open' : undefined}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <td className="cb-when" title={new Date(row.startedAt).toLocaleString()}>
        <div>{formatWhen(row.startedAt)}</div>
        <div className="cell-sub">
          {leadTime} · {ago(row.startedAt)}
        </div>
      </td>
      <td className="cb-who">
        <div className="cell-name">
          <Highlight text={name} term={term} />
        </div>
        <div className="cell-sub">
          {[person, row.phone, row.lead?.place].filter(Boolean).join(' · ')}
        </div>
        <div className="cell-badges">
          {!row.lead && <span className={`badge ${row.isTest ? 'yellow' : ''}`}>{row.isTest ? 'test' : 'not a lead'}</span>}
          {row.timesCalled > 1 && <span className="badge purple">called {row.timesCalled}×</span>}
        </div>
      </td>
      <td className="cb-handled">
        <span className={`badge ${HANDLED_TONE[row.handledBy]}`}>{INBOUND_LABEL[row.handledBy]}</span>
        {reason && <div className="cell-sub">{reason}</div>}
      </td>
      <td className="cb-length num">{formatClock(row.duration)}</td>
      <td className="cb-before">
        {last ? (
          <>
            <div>
              {gap(last.startedAt, row.startedAt)} after{' '}
              {last.disposition && (
                <span className={`badge ${outcomeTone(last.disposition)}`}>{outcomeText(last.disposition, last.dispositionLabel)}</span>
              )}
            </div>
            <div className="cell-sub">
              {callerName(last.username)} · {row.ourCalls} {row.ourCalls === 1 ? 'call' : 'calls'} before
            </div>
          </>
        ) : (
          <span className="muted">{row.lead ? 'never called' : '—'}</span>
        )}
      </td>
      <td className="cb-status">
        {row.lead?.status ? (
          <span className={`badge ${row.lead.status === 'callback' ? 'purple' : row.lead.status === 'lost' || row.lead.status === 'dnc' ? 'red' : ''}`}>
            {row.lead.status}
          </span>
        ) : (
          <span className="muted">—</span>
        )}
        {row.lead?.doNotCall && row.lead.status !== 'dnc' && <span className="badge red">do not call</span>}
      </td>
      <td className="cb-wanted">
        {wanted || row.snippet ? (
          <span className="cell-snippet">
            <Highlight text={wanted || `“${row.snippet}”`} term={term} />
          </span>
        ) : (
          <span className="muted">{row.handledBy === 'human' ? 'You took it, no notes' : '—'}</span>
        )}
        {s?.flags && s.flags.length > 0 && (
          <div className="cell-badges">
            {s.flags.map((f) => (
              <span key={f} className={`badge ${f === 'do_not_call' || f === 'spam' ? 'red' : 'yellow'}`}>
                {f.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  )
}
