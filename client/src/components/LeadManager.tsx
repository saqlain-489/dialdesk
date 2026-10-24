import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Facets, Lead, LeadFilters as Filters, OrgSummary } from '../types'
import { LeadFilters } from './LeadFilters'
import { Pager } from './Pager'

// `targets` are the other workspaces the owner can move worked-out leads to; `orgNames`
// labels where a lead came from or went.
export function LeadManager({ targets, orgNames }: { targets: OrgSummary[]; orgNames: Record<string, string> }) {
  const [filters, setFilters] = useState<Filters>({ view: 'all', limit: 50, offset: 0 })
  const [facets, setFacets] = useState<Facets | null>(null)
  const [leads, setLeads] = useState<Lead[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [moveTo, setMoveTo] = useState(targets[0]?.id ?? '')
  const [confirmMove, setConfirmMove] = useState(false)

  const load = useCallback(async () => {
    try {
      const [queue, facetData] = await Promise.all([api.queue(filters), api.facets()])
      setLeads(queue.leads)
      setTotal(queue.total)
      setOffset(queue.offset)
      setFacets(facetData)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [filters])

  useEffect(() => {
    void load()
  }, [load])

  // Any mutation invalidates both the list and the counts, so they reload together
  // rather than leaving a stale "Archived (12)" next to a list that says otherwise.
  async function act(id: string, fn: () => Promise<unknown>, note: string) {
    setBusyId(id)
    setMessage(null)
    try {
      await fn()
      setMessage(note)
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function runBulkArchive() {
    setMessage(null)
    try {
      const result = await api.bulkArchive(filters, total, 'bulk archived from admin')
      setMessage(`Archived ${result.archived} leads.`)
      setConfirmBulk(false)
      await load()
    } catch (err) {
      // A 409 here means the count moved between preview and confirm — the server
      // refuses rather than archiving a different set than the one shown.
      setError((err as Error).message)
      setConfirmBulk(false)
      await load()
    }
  }

  async function runBulkRecycle() {
    setMessage(null)
    try {
      const result = await api.bulkRecycle(filters, total, moveTo)
      setMessage(
        `Moved ${result.recycled} leads to ${orgNames[moveTo] ?? 'the other workspace'}` +
          (result.skipped ? ` (${result.skipped} no longer eligible).` : '.'),
      )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setConfirmMove(false)
      await load()
    }
  }

  const view = filters.view ?? 'all'
  const targetName = orgNames[moveTo] ?? ''

  return (
    <div className="page">
      <div className="page-head">
        <h2>Leads</h2>
        <span className="badge">{total.toLocaleString()} matching</span>
        <span className="spacer" />
        <button onClick={() => void load()}>Refresh</button>
      </div>

      {error && <div className="error-box">{error}</div>}
      {message && (
        <div className="notice" style={{ marginBottom: 12 }}>
          {message}
        </div>
      )}

      <div className="filter-bar">
        <LeadFilters
          filters={filters}
          facets={facets}
          onChange={(next) => setFilters({ ...next, offset: 0 })}
          showView
          canRecycle={targets.length > 0}
        />
      </div>

      {view === 'recyclable' && (
        <div className="card-section">
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Lost leads that have rested since their last call. Moving one gives it a fresh start in the other
            workspace: no notes, attempts or history go with it, and its calls stay here.
          </div>
          {total > 0 && targets.length > 0 && (
            <div className="stack">
              <div className="btn-row">
                <select aria-label="Move to workspace" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} style={{ flex: 1 }}>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {!confirmMove && (
                  <button className="primary" onClick={() => setConfirmMove(true)} style={{ flex: 2 }}>
                    Move all {total} to {targetName}
                  </button>
                )}
              </div>
              {confirmMove && (
                <div className="stack">
                  <div>
                    Move <strong>{total}</strong> leads to <strong>{targetName}</strong>? They start over there as new
                    leads.
                  </div>
                  <div className="btn-row">
                    <button className="primary" onClick={() => void runBulkRecycle()}>
                      Yes, move {total}
                    </button>
                    <button onClick={() => setConfirmMove(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {view !== 'archived' && view !== 'recyclable' && total > 0 && (
        <div className="card-section">
          {!confirmBulk ? (
            <button onClick={() => setConfirmBulk(true)} style={{ width: '100%' }}>
              Archive all {total} matching leads
            </button>
          ) : (
            <div className="stack">
              <div>
                Archive <strong>{total}</strong> leads matching the current filters? They stay in
                the database and can be restored.
              </div>
              <div className="btn-row">
                <button className="danger" onClick={() => void runBulkArchive()}>
                  Yes, archive {total}
                </button>
                <button onClick={() => setConfirmBulk(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {leads.length === 0 && <div className="notice">No leads match these filters.</div>}

      <div>
        {leads.map((lead) => (
          <div key={lead.id} className={`lead-row${lead.archivedAt ? ' is-archived' : ''}`}>
            <div className="lead-info">
              <span className="lead-name">{lead.businessName}</span>
              <span className="mono muted">{lead.phoneDisplay}</span>
              <span className="badge">{lead.status}</span>
              {lead.attempts > 0 && <span className="badge yellow">{lead.attempts}×</span>}
              {lead.city && <span className="badge">{lead.city}</span>}
              {lead.archivedAt && <span className="badge red">archived</span>}
              {lead.doNotCall && <span className="badge red">DNC</span>}
              {lead.recycledFrom && (
                <span className="badge" title={`Moved in ${new Date(lead.recycledFrom.at).toLocaleDateString()}`}>
                  from {orgNames[lead.recycledFrom.orgId] ?? 'another workspace'}
                </span>
              )}
              {lead.recycle && (
                <span className="badge yellow">
                  {lead.recycle.state === 'done' ? 'moved' : 'moving'} to {orgNames[lead.recycle.to] ?? 'another workspace'}
                </span>
              )}
            </div>

            <div className="lead-actions">
              {view === 'recyclable' && targets.length > 0 && (
                <button
                  disabled={busyId === lead.id}
                  onClick={() =>
                    void act(lead.id, () => api.recycleLead(lead.id, moveTo), `Moved ${lead.businessName} to ${targetName}.`)
                  }
                >
                  Move to {targetName}
                </button>
              )}
              {lead.recycle ? null : lead.archivedAt ? (
                <button
                  disabled={busyId === lead.id}
                  onClick={() => void act(lead.id, () => api.restoreLead(lead.id), 'Restored.')}
                >
                  Restore
                </button>
              ) : (
                <button
                  disabled={busyId === lead.id}
                  onClick={() => void act(lead.id, () => api.archiveLead(lead.id), 'Archived.')}
                >
                  Archive
                </button>
              )}

              <button
                className="danger"
                disabled={busyId === lead.id}
                onClick={() => {
                  const ok = window.confirm(
                    `Permanently delete ${lead.businessName} and its call history?\n\nThis cannot be undone. Archive instead if you might want it back.`,
                  )
                  if (ok) {
                    void act(
                      lead.id,
                      () => api.deleteLead(lead.id),
                      `Deleted ${lead.businessName}.`,
                    )
                  }
                }}
              >
                Delete
              </button>
            </div>

            <div className="lead-meta">
              {lead.createdAt && <>added {new Date(lead.createdAt).toLocaleDateString()} · </>}
              {lead.lastCalledAt
                ? `last called ${new Date(lead.lastCalledAt).toLocaleDateString()}`
                : 'never called'}
              {lead.lane && <> · {lead.lane}</>}
              {lead.archivedReason && <> · {lead.archivedReason}</>}
            </div>
          </div>
        ))}
      </div>

      <Pager
        total={total}
        offset={offset}
        limit={filters.limit ?? 50}
        onChange={({ offset: nextOffset, limit }) =>
          setFilters({ ...filters, offset: nextOffset, limit })
        }
      />
    </div>
  )
}
