import type { Facets, Lead, LeadFilters as Filters } from '../types'
import { LeadFilters } from './LeadFilters'
import { Pager } from './Pager'

const STATUS_TONE: Record<string, string> = {
  new: '',
  contacted: 'yellow',
  callback: 'purple',
  booked: 'green',
  won: 'green',
  lost: 'red',
  dnc: 'red',
}

export function Queue({
  leads,
  total,
  activeId,
  onSelect,
  filters,
  facets,
  onFiltersChange,
  offset,
}: {
  leads: Lead[]
  total: number
  activeId: string | null
  onSelect: (lead: Lead) => void
  filters: Filters
  facets: Facets | null
  onFiltersChange: (next: Filters) => void
  offset: number
}) {
  return (
    <div className="pane queue-pane">
      <h2>Queue · {total.toLocaleString()}</h2>
      <LeadFilters
        filters={filters}
        facets={facets}
        onChange={(next) => onFiltersChange({ ...next, offset: 0 })}
      />
      {leads.length === 0 && (
        <div className="notice">
          No leads in the queue. Import a CSV from the admin view to get started.
        </div>
      )}
      {leads.map((lead) => (
        <div
          key={lead.id}
          className={`queue-item${lead.id === activeId ? ' active' : ''}`}
          onClick={() => onSelect(lead)}
        >
          <div className="name">{lead.businessName}</div>
          <div className="meta">
            <span className="mono">{lead.phoneDisplay}</span>
            {lead.status !== 'new' && (
              <span className={`badge ${STATUS_TONE[lead.status] ?? ''}`}>{lead.status}</span>
            )}
            {lead.attempts > 0 && <span>{lead.attempts}×</span>}
          </div>
        </div>
      ))}

      <Pager
        total={total}
        offset={offset}
        limit={filters.limit ?? 50}
        onChange={(next) => onFiltersChange({ ...filters, ...next })}
        showPageSize={false}
      />
    </div>
  )
}
