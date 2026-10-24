const PAGE_SIZES = [25, 50, 100, 200]

/**
 * Offset pagination controls. Deliberately shows first/prev/next/last plus a page
 * number rather than a full page list: at 30k leads and 50 per page that is 600
 * buttons, and nobody navigates a call list by jumping to page 437.
 */
export function Pager({
  total,
  offset,
  limit,
  onChange,
  showPageSize = true,
  pageSizes = PAGE_SIZES,
}: {
  total: number
  offset: number
  limit: number
  onChange: (next: { offset: number; limit: number }) => void
  showPageSize?: boolean
  pageSizes?: number[]
}) {
  if (total === 0) return null

  const pageCount = Math.max(1, Math.ceil(total / limit))
  const page = Math.floor(offset / limit) + 1
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(offset + limit, total)

  const go = (nextPage: number) => {
    const clamped = Math.min(Math.max(nextPage, 1), pageCount)
    onChange({ offset: (clamped - 1) * limit, limit })
  }

  return (
    <div className="pager">
      <span className="pager-info">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>

      <span className="spacer" />

      {showPageSize && (
        <select
          value={limit}
          onChange={(e) =>
            // Reset to the first page: keeping the offset would land the user in a
            // different part of the list than the one they were reading.
            onChange({ offset: 0, limit: Number(e.target.value) })
          }
          title="Rows per page"
        >
          {pageSizes.map((size) => (
            <option key={size} value={size}>
              {size} / page
            </option>
          ))}
        </select>
      )}

      <button onClick={() => go(1)} disabled={page === 1} title="First page">
        ««
      </button>
      <button onClick={() => go(page - 1)} disabled={page === 1}>
        ‹ Prev
      </button>
      <span className="pager-info mono">
        {page} / {pageCount.toLocaleString()}
      </span>
      <button onClick={() => go(page + 1)} disabled={page >= pageCount}>
        Next ›
      </button>
      <button onClick={() => go(pageCount)} disabled={page >= pageCount} title="Last page">
        »»
      </button>
    </div>
  )
}
