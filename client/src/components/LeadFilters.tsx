import { useState } from 'react'
import type { Facets, LeadFilters as Filters } from '../types'

const AGE_OPTIONS = [
  { value: '', label: 'Any age' },
  { value: '30', label: 'Added 30+ days ago' },
  { value: '90', label: 'Added 90+ days ago' },
  { value: '180', label: 'Added 6+ months ago' },
  { value: '365', label: 'Added 1+ year ago' },
]

const UNCALLED_OPTIONS = [
  { value: '', label: 'Any last-call date' },
  { value: '7', label: 'Not called in 7+ days' },
  { value: '30', label: 'Not called in 30+ days' },
  { value: '90', label: 'Not called in 90+ days' },
]

export function LeadFilters({
  filters,
  facets,
  onChange,
  showView,
  canRecycle = false,
}: {
  filters: Filters
  facets: Facets | null
  onChange: (next: Filters) => void
  showView?: boolean
  // Offered only when the owner has another workspace to move leads to.
  canRecycle?: boolean
}) {
  const set = (key: keyof Filters, value: string) => onChange({ ...filters, [key]: value })
  // Collapsed by default: eight stacked selects push the lead list off screen, and
  // the list is what the caller actually works from.
  const [open, setOpen] = useState(false)

  // Everything except the view and the free-text box counts as "narrowing", which is
  // what the Clear button resets and what the count badge refers to.
  const activeCount = (Object.keys(filters) as (keyof Filters)[]).filter(
    (k) => k !== 'view' && k !== 'limit' && k !== 'search' && filters[k],
  ).length

  return (
    <div className="stack" style={{ marginBottom: 10, gap: 6 }}>
      <input
        placeholder="Search name or phone…"
        value={filters.search ?? ''}
        onChange={(e) => set('search', e.target.value)}
      />

      {showView && (
        <div className="btn-row">
          {(canRecycle ? (['queue', 'all', 'archived', 'recyclable'] as const) : (['queue', 'all', 'archived'] as const)).map((view) => (
            <button
              key={view}
              className={(filters.view ?? 'queue') === view ? 'primary' : ''}
              onClick={() => onChange({ ...filters, view })}
              style={{ flex: 1 }}
            >
              {view === 'queue'
                ? 'Callable'
                : view === 'all'
                  ? 'All'
                  : view === 'recyclable'
                    ? 'Recyclable'
                    : `Archived${facets ? ` (${facets.archivedCount})` : ''}`}
            </button>
          ))}
        </div>
      )}

      <button onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide filters' : `Filters${activeCount ? ` · ${activeCount} active` : ''}`}
      </button>

      {(open || activeCount > 0) && (
        <>
      <select value={filters.status ?? ''} onChange={(e) => set('status', e.target.value)}>
        <option value="">Any status</option>
        {facets?.statuses.map((s) => (
          <option key={s.status} value={s.status}>
            {s.status} ({s.count})
          </option>
        ))}
      </select>

      <select value={filters.lane ?? ''} onChange={(e) => set('lane', e.target.value)}>
        <option value="">Any lane</option>
        {facets?.lanes.map((lane) => (
          <option key={lane} value={lane}>
            {lane}
          </option>
        ))}
      </select>

      <select value={filters.issue ?? ''} onChange={(e) => set('issue', e.target.value)}>
        <option value="">Any site issue</option>
        {facets?.issues.map((issue) => (
          <option key={issue} value={issue}>
            {issue}
          </option>
        ))}
      </select>

      {(facets?.cities.length ?? 0) > 1 && (
        <select value={filters.city ?? ''} onChange={(e) => set('city', e.target.value)}>
          <option value="">Any city</option>
          {facets?.cities.map((city) => (
            <option key={city} value={city}>
              {city}
            </option>
          ))}
        </select>
      )}

      {(facets?.states.length ?? 0) > 1 && (
        <select value={filters.state ?? ''} onChange={(e) => set('state', e.target.value)}>
          <option value="">Any state</option>
          {facets?.states.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      )}

      <select value={filters.batch ?? ''} onChange={(e) => set('batch', e.target.value)}>
        <option value="">Any batch</option>
        {facets?.batches.map((batch) => (
          <option key={batch} value={batch}>
            {batch}
          </option>
        ))}
      </select>

      <select
        value={filters.olderThanDays ?? ''}
        onChange={(e) => set('olderThanDays', e.target.value)}
      >
        {AGE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <select
        value={filters.notCalledSinceDays ?? ''}
        onChange={(e) => set('notCalledSinceDays', e.target.value)}
      >
        {UNCALLED_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <div className="btn-row">
        <select
          value={filters.minAttempts ?? ''}
          onChange={(e) => set('minAttempts', e.target.value)}
          style={{ flex: 1 }}
        >
          <option value="">Any attempts</option>
          <option value="1">1+ attempts</option>
          <option value="3">3+ attempts</option>
          <option value="5">5+ attempts</option>
        </select>
        <select
          value={filters.hasEmail ?? ''}
          onChange={(e) => set('hasEmail', e.target.value)}
          style={{ flex: 1 }}
        >
          <option value="">Email: any</option>
          <option value="true">Has email</option>
          <option value="false">No email</option>
        </select>
      </div>

      {activeCount > 0 && (
        <button
          onClick={() =>
            onChange({ view: filters.view, search: filters.search, limit: filters.limit })
          }
        >
          Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
        </button>
      )}
        </>
      )}
    </div>
  )
}
