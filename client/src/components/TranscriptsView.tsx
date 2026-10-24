import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { callerName, formatClock, formatWhen, TRANSCRIPT_FAILED_TEXT } from '../lib/callFormat'
import { OUTCOME_LABEL, outcomeText, outcomeTone } from '../lib/outcome'
import { NARROW_QUERY } from '../lib/platform'
import type { Disposition, TranscriptDetail, TranscriptPage, TranscriptQuery, TranscriptRow, TranscriptSort } from '../types'
import { Highlight } from './Highlight'
import { Pager } from './Pager'
import { TranscriptDrawer } from './TranscriptDrawer'

const DEFAULT_QUERY: TranscriptQuery = { sort: 'startedAt', dir: 'desc', limit: 10, offset: 0 }
const FILTER_KEYS = ['search', 'real', 'outcome', 'caller', 'direction', 'minSeconds', 'days', 'status'] as const

const COLUMNS: { key: TranscriptSort; label: string; className?: string; title?: string }[] = [
  { key: 'startedAt', label: 'When', className: 'col-when' },
  { key: 'business', label: 'Business', className: 'col-business' },
  { key: 'caller', label: 'Caller', className: 'col-caller' },
  { key: 'attempt', label: '#', className: 'col-attempt num', title: 'Attempt number on this lead' },
  { key: 'duration', label: 'Length', className: 'col-length num' },
  { key: 'outcome', label: 'Outcome', className: 'col-outcome' },
]

const SORT_LABEL: Record<TranscriptSort, string> = {
  startedAt: 'Date',
  business: 'Business',
  caller: 'Caller',
  attempt: 'Attempt',
  duration: 'Length',
  outcome: 'Outcome',
}

const SPEAKER_SHORT = { caller: 'Us', lead: 'Them', ai: 'AI' } as const

export function TranscriptsView() {
  const [query, setQuery] = useState<TranscriptQuery>(DEFAULT_QUERY)
  const [searchText, setSearchText] = useState('')
  const [page, setPage] = useState<TranscriptPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const narrow = useMediaQuery(NARROW_QUERY)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const requestSeq = useRef(0)
  const openAfterLoad = useRef<'first' | 'last' | null>(null)
  const details = useRef(new Map<string, TranscriptDetail>())

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
      const data = await api.transcripts(query)
      // A slower earlier request (e.g. a half-typed search) must not overwrite a newer one.
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

  const update = (patch: Partial<TranscriptQuery>) => setQuery((q) => ({ ...q, ...patch, offset: 0 }))

  const sortBy = (key: TranscriptSort) =>
    setQuery((q) => ({
      ...q,
      sort: key,
      dir: q.sort === key ? (q.dir === 'asc' ? 'desc' : 'asc') : key === 'business' || key === 'caller' ? 'asc' : 'desc',
      offset: 0,
    }))

  const clearFilters = () => {
    setSearchText('')
    setQuery((q) => ({ ...DEFAULT_QUERY, sort: q.sort, dir: q.dir, limit: q.limit }))
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

  // Stepping past either end of the page loads the neighbouring page and keeps reading.
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

  const activeFilters = FILTER_KEYS.filter((k) => query[k]).length + (searchText.trim() && !query.search ? 1 : 0)
  const narrowedBy = FILTER_KEYS.filter((k) => k !== 'search' && k !== 'real' && query[k]).length
  const failedView = query.status === 'failed'
  const openRow = rows.find((r) => r.id === openId) ?? null

  return (
    <div className="page">
      <div className="page-head">
        <h2>Call transcripts</h2>
        {page && (
          <span className="badge">
            {total.toLocaleString()} {failedView ? 'failed' : total === 1 ? 'transcript' : 'transcripts'}
          </span>
        )}
        {loading && page && <span className="muted" style={{ fontSize: 12 }}>Updating…</span>}
        <span className="spacer" />
        <button onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>
      <p className="muted page-intro">
        Transcribed on the caller's machine after each recorded call; audio is never uploaded or stored. Read these to
        fix the script, not to check up on anyone.
      </p>

      <div className="transcript-toolbar">
        <input
          type="search"
          className="toolbar-search"
          placeholder="Search business, phone or words said…"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        <button
          className={query.real ? 'primary' : ''}
          aria-pressed={Boolean(query.real)}
          onClick={() => update({ real: query.real ? '' : '1' })}
          title="Hide voicemails and calls under 30 seconds"
        >
          {query.real ? '✓ ' : ''}Real conversations
        </button>
        {narrow && (
          <button className={filtersOpen ? 'primary' : ''} onClick={() => setFiltersOpen((open) => !open)}>
            Filters{narrowedBy > 0 ? ` (${narrowedBy})` : ''}
          </button>
        )}
        {(!narrow || filtersOpen) && (
          <>
            <select value={query.outcome ?? ''} onChange={(e) => update({ outcome: e.target.value })} title="Outcome">
              <option value="">Any outcome</option>
              {(Object.keys(OUTCOME_LABEL) as Disposition[]).map((d) => (
                <option key={d} value={d}>
                  {OUTCOME_LABEL[d]}
                </option>
              ))}
              <option value="none">No outcome picked</option>
            </select>
            <select value={query.caller ?? ''} onChange={(e) => update({ caller: e.target.value })} title="Caller">
              <option value="">Any caller</option>
              {page?.callers.map((c) => (
                <option key={c} value={c}>
                  {callerName(c)}
                </option>
              ))}
            </select>
            <select value={query.direction ?? ''} onChange={(e) => update({ direction: e.target.value })} title="Call type">
              <option value="">All calls</option>
              <option value="outbound">Our calls</option>
              <option value="inbound">They called us</option>
            </select>
            <select value={query.minSeconds ?? ''} onChange={(e) => update({ minSeconds: e.target.value })} title="Length">
              <option value="">Any length</option>
              <option value="15">15 s or longer</option>
              <option value="30">30 s or longer</option>
              <option value="60">1 min or longer</option>
              <option value="120">2 min or longer</option>
            </select>
            <select value={query.days ?? ''} onChange={(e) => update({ days: e.target.value })} title="Date">
              <option value="">Any date</option>
              <option value="1">Last 24 hours</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
            </select>
            <select value={query.status ?? ''} onChange={(e) => update({ status: e.target.value })} title="Transcript status">
              <option value="">Has a transcript</option>
              <option value="failed">Transcript failed</option>
            </select>
          </>
        )}
        <select
          className="toolbar-sort"
          value={`${query.sort}:${query.dir}`}
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(':') as [TranscriptSort, 'asc' | 'desc']
            setQuery((q) => ({ ...q, sort, dir, offset: 0 }))
          }}
          title="Sort"
        >
          {COLUMNS.flatMap((c) => [
            <option key={`${c.key}:desc`} value={`${c.key}:desc`}>
              Sort: {SORT_LABEL[c.key]} ↓
            </option>,
            <option key={`${c.key}:asc`} value={`${c.key}:asc`}>
              Sort: {SORT_LABEL[c.key]} ↑
            </option>,
          ])}
        </select>
        {activeFilters > 0 && (
          <button className="toolbar-clear" onClick={clearFilters}>
            Clear filters ({activeFilters})
          </button>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className={`table-wrap${loading && page ? ' is-loading' : ''}`}>
        <table className="data-table transcripts-table">
          <colgroup>
            <col className="col-when" />
            <col className="col-business" />
            <col className="col-caller" />
            <col className="col-attempt" />
            <col className="col-length" />
            <col className="col-outcome" />
            <col />
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((col) => {
                const sorted = query.sort === col.key
                return (
                  <th
                    key={col.key}
                    className={col.className}
                    aria-sort={sorted ? (query.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    title={col.title}
                  >
                    <button className={`sort-btn${sorted ? ' is-sorted' : ''}`} onClick={() => sortBy(col.key)}>
                      {col.label}
                      <span className="sort-arrow" aria-hidden>
                        {sorted ? (query.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  </th>
                )
              })}
              <th>{failedView ? 'Why there is no transcript' : 'What was said'}</th>
            </tr>
          </thead>
          <tbody>
            {!page &&
              loading &&
              Array.from({ length: 6 }, (_, i) => (
                <tr key={i} className="skeleton-row">
                  {Array.from({ length: 7 }, (_, j) => (
                    <td key={j}>
                      <span className="skeleton" />
                    </td>
                  ))}
                </tr>
              ))}
            {rows.map((row) => (
              <Row key={row.id} row={row} term={query.search} open={row.id === openId} onOpen={() => setOpenId(row.id)} />
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
            ) : failedView ? (
              <div>No failed transcripts.</div>
            ) : (
              <div>
                No transcripts yet. They appear a minute or so after each recorded call, while the caller dials the next
                lead.
              </div>
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
          row={openRow}
          term={query.search}
          position={openIndex >= 0 ? query.offset + openIndex + 1 : null}
          total={total}
          fetchDetail={fetchDetail}
          onClose={() => setOpenId(null)}
          onPrev={hasPrev ? () => step(-1) : undefined}
          onNext={hasNext ? () => step(1) : undefined}
        />
      )}
    </div>
  )
}

function Row({ row, term, open, onOpen }: { row: TranscriptRow; term?: string; open: boolean; onOpen: () => void }) {
  const inbound = row.direction === 'inbound'
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
      <td className="col-when" title={new Date(row.startedAt).toLocaleString()}>
        {formatWhen(row.startedAt)}
      </td>
      <td className="col-business">
        <div className="cell-name">
          <Highlight text={row.businessName ?? (inbound ? 'Unknown caller' : 'Unknown')} term={term} />
        </div>
        <div className="cell-sub">
          {inbound && <span className="badge purple">called us</span>} {row.phone ?? ''}
        </div>
      </td>
      <td className="col-caller">{inbound ? 'AI' : callerName(row.username)}</td>
      <td className="col-attempt num">{inbound ? '—' : (row.attemptNumber ?? '—')}</td>
      <td className="col-length num">{formatClock(row.duration)}</td>
      <td className={`col-outcome${row.disposition ? '' : ' is-empty'}`}>
        {row.disposition ? (
          <span className={`badge ${outcomeTone(row.disposition)}`}>{outcomeText(row.disposition, row.dispositionLabel)}</span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="col-said">
        {row.error ? (
          <span className="badge red">{TRANSCRIPT_FAILED_TEXT[row.error.stage] ?? row.error.stage}</span>
        ) : row.snippet ? (
          <span className="cell-snippet">
            {row.snippet.speaker && <span className="snippet-speaker">{SPEAKER_SHORT[row.snippet.speaker]}:</span>}{' '}
            <Highlight text={row.snippet.text} term={term} />
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  )
}
