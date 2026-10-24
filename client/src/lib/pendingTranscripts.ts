import type { AsrResult } from '../workers/transcribe.worker'

// Recordings wait here in the caller's own browser (never uploaded); in tab memory a closed tab lost them all.
export type PendingJob = {
  sid: string
  // The workspace the call was made in; its transcript can only be saved from that workspace.
  // Absent on recordings made before workspaces existed, when there was only one.
  orgId?: string
  blob: Blob
  createdAt: number
  // Each finished side is kept, so an interrupted job only redoes the side it was on.
  caller?: AsrResult | null
  lead?: AsrResult | null
}

// After this the call is too stale to be worth the CPU; it is dropped and reported.
export const PENDING_MAX_AGE_MS = 48 * 60 * 60 * 1000

const DB_NAME = 'dialdesk-transcripts'
const STORE = 'pending'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'sid' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const request = work(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// Storage failures (private window, full disk) must never break the call flow; the job just stays in memory.
export async function savePending(job: PendingJob): Promise<void> {
  try {
    await run('readwrite', (store) => store.put(job))
  } catch {
    /* memory-only for this job */
  }
}

export async function loadPending(): Promise<PendingJob[]> {
  try {
    return await run<PendingJob[]>('readonly', (store) => store.getAll())
  } catch {
    return []
  }
}

export async function deletePending(sid: string): Promise<void> {
  try {
    await run('readwrite', (store) => store.delete(sid))
  } catch {
    /* nothing to clean up */
  }
}
