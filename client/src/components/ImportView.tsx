import { useCallback, useRef, useState } from 'react'
import { api } from '../api'
import type { ImportResult } from '../types'
import { isPhoneOrTablet } from '../lib/platform'

const ACCEPTED = ['.csv', 'text/csv', 'application/vnd.ms-excel']

function looksLikeCsv(file: File): boolean {
  return file.name.toLowerCase().endsWith('.csv') || ACCEPTED.includes(file.type)
}

export function ImportView({ workspace }: { workspace: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  // Counts enter/leave rather than toggling a boolean: dragging over a child element
  // fires dragleave on the parent, so a plain flag flickers the highlight off while
  // the pointer is still inside the zone.
  const dragDepth = useRef(0)

  const [dragging, setDragging] = useState(false)
  const [batch, setBatch] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)

  const upload = useCallback(
    async (file: File) => {
      if (!looksLikeCsv(file)) {
        setError(`“${file.name}” is not a CSV. Save it as CSV and try again.`)
        return
      }
      setBusy(true)
      setError(null)
      setResult(null)
      setFileName(file.name)
      try {
        setResult(await api.importCsv(file, batch.trim() || undefined))
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setBusy(false)
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [batch],
  )

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const file = event.dataTransfer.files?.[0]
      if (file) void upload(file)
    },
    [upload],
  )

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <h2>Import leads</h2>
      </div>

      <div className="notice" role="status">
        Importing into <strong>{workspace}</strong>. A company another workspace already owns is skipped, and so is
        any number on the do-not-call list.
      </div>

      <p className="muted page-intro">
        A CSV with at least a name and a phone column. Phones are normalized to E.164 on the way
        in, and re-importing the same list refreshes lead details <strong>without</strong> resetting
        call progress — so it is safe to re-upload after refreshing the list.
      </p>

      <div className="card-section">
        <h4>Batch name (optional)</h4>
        <input
          placeholder="e.g. spring-list"
          value={batch}
          onChange={(e) => setBatch(e.target.value)}
          disabled={busy}
        />
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Tags every row in this upload so you can filter or archive the whole batch later. Left
          blank, the server names it from today's date.
        </div>
      </div>

      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`}
        onDragEnter={(e) => {
          e.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(e) => {
          // Without preventDefault on dragover the browser navigates to the file
          // instead of firing our drop handler.
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          dragDepth.current -= 1
          if (dragDepth.current <= 0) {
            dragDepth.current = 0
            setDragging(false)
          }
        }}
        onDrop={onDrop}
        onClick={() => !busy && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
      >
        <div className="dropzone-icon">{busy ? '⏳' : '⬆'}</div>
        <div className="dropzone-title">
          {busy
            ? `Importing ${fileName ?? 'file'}…`
            : dragging
              ? 'Drop to import'
              : isPhoneOrTablet
                ? 'Import a CSV'
                : 'Drop a CSV here'}
        </div>
        {!busy && <div className="muted">{isPhoneOrTablet ? 'Tap to choose a file' : 'or click to choose a file'}</div>}

        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void upload(file)
          }}
        />
      </div>

      {error && <div className="error-box">{error}</div>}

      {result && (
        <div className="card-section">
          <h4>Imported {fileName ? `“${fileName}”` : ''}</h4>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="badge green">{result.imported} new</span>
            <span className="badge">{result.updated} updated</span>
            {result.duplicatesInFile > 0 && (
              <span className="badge yellow">{result.duplicatesInFile} dupes in file</span>
            )}
            {result.skippedNoPhone > 0 && (
              <span className="badge yellow">{result.skippedNoPhone} no phone</span>
            )}
            {result.skippedBadPhone > 0 && (
              <span className="badge red">{result.skippedBadPhone} bad phone</span>
            )}
            {result.skippedOwnedElsewhere > 0 && (
              <span className="badge yellow">{result.skippedOwnedElsewhere} owned by another workspace</span>
            )}
            {result.skippedDoNotCall > 0 && (
              <span className="badge yellow">{result.skippedDoNotCall} do not call</span>
            )}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Batch “{result.batch}” · {result.totalRows} rows read
          </div>
          {result.errors.length > 0 && (
            <>
              <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                Rows the importer skipped:
              </div>
              <ul className="issue-list muted" style={{ fontSize: 12, marginTop: 4 }}>
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="card-section">
        <h4>Columns it reads</h4>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          <code>business_name</code>, <code>phone</code>, <code>website</code>, <code>email</code>,{' '}
          <code>owner_name</code>, <code>city</code>, <code>state</code>, <code>category</code>, <code>rating</code>,{' '}
          <code>site_issues</code> (semicolon-separated) and <code>do_not_contact</code>, plus common aliases. Columns
          are matched by name, so the column order does not matter and extra columns are ignored.
        </p>
      </div>
    </div>
  )
}
