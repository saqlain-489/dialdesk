import type {
  CallbackPage,
  CallbackQuery,
  CallHistoryEntry,
  CallStatus,
  CallWindow,
  Disposition,
  Facets,
  ImportResult,
  LeadDetail,
  LeadFilters,
  LeadStatus,
  OrgSetup,
  QueueResponse,
  Session,
  StatsOverview,
  TranscriptDetail,
  TranscriptLine,
  TranscriptPage,
  TranscriptQuery,
  TranscriptRow,
} from '../types'
import {
  DEMO_ORGS,
  DEMO_TIME_ZONE,
  DEMO_TRANSCRIBE_STATES,
  DEMO_USER,
  demoConversation,
  formatPhone,
  generateOrgData,
  type DemoCall,
  type DemoLead,
  type DemoOrg,
} from './data'

// Mirrors the server's queries over in-memory fictional data, so the real components render unchanged.

type OrgData = { org: DemoOrg; leads: DemoLead[]; calls: DemoCall[] }

const ORG_KEY = 'dd.demoOrg'
const SIGNED_OUT_KEY = 'dd.demoSignedOut'
const DAY = 86_400_000

let now = 0
const orgs = new Map<string, OrgData>()

function readKey(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function writeKey(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, value)
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}

function data(orgId?: string): OrgData {
  now ||= Date.now()
  const org = DEMO_ORGS.find((o) => o.id === (orgId ?? readKey(ORG_KEY))) ?? DEMO_ORGS[0]!
  let entry = orgs.get(org.id)
  if (!entry) {
    entry = { org, ...generateOrgData(org, now) }
    orgs.set(org.id, entry)
  }
  return entry
}

export class DemoError extends Error {}

const fail = (message: string): never => {
  throw new DemoError(message)
}

// --- session -----------------------------------------------------------------

export function session(): Session {
  if (readKey(SIGNED_OUT_KEY)) fail('not authenticated')
  const { org } = data()
  return {
    user: DEMO_USER,
    org: { id: org.id, name: org.name, role: 'owner', companyName: org.companyName },
    orgs: DEMO_ORGS.map((o) => ({ id: o.id, name: o.name, role: 'owner' as const })),
  }
}

export function signIn(): Session {
  writeKey(SIGNED_OUT_KEY, null)
  return session()
}

export function signOut(): void {
  writeKey(SIGNED_OUT_KEY, '1')
}

export function switchOrg(orgId: string): Session {
  if (!DEMO_ORGS.some((o) => o.id === orgId)) fail('no access to that workspace')
  writeKey(ORG_KEY, orgId)
  return session()
}

export function callWindow(): CallWindow {
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: DEMO_TIME_ZONE,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date())
  return {
    open: true,
    reason: `Demo: calling hours are not enforced (lead local time ${label})`,
    leadLocalTime: label,
    leadTimeZone: DEMO_TIME_ZONE,
  }
}

export function orgSetup(): OrgSetup {
  const { org } = data()
  return {
    workspace: org.name,
    twilioConfigured: true,
    callerId: formatPhone(org.callerId),
    callWindow: callWindow(),
    voiceWebhookUrl: `https://dialdesk.example.com/api/twilio/o/${org.slug}/voice`,
  }
}

// --- leads ---------------------------------------------------------------------

const CLOSED: LeadStatus[] = ['dnc', 'won', 'lost', 'booked']

function matches(lead: DemoLead, q: LeadFilters): boolean {
  const view = q.view ?? 'queue'
  const t = Date.now()
  if (view === 'queue') {
    if (!lead.claimed || lead.doNotCall || lead.archivedAt || CLOSED.includes(lead.status)) return false
    if (lead.nextCallbackAt && new Date(lead.nextCallbackAt).getTime() > t) return false
  }
  if (view === 'archived' && !lead.archivedAt) return false
  if (view === 'recyclable') {
    const rested = lead.lastCalledAt && new Date(lead.lastCalledAt).getTime() <= t - 60 * DAY
    if (lead.status !== 'lost' || lead.doNotCall || lead.lastDisposition === 'wrong_number' || !rested) return false
  }
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (q.status && !list(q.status).includes(lead.status)) return false
  if (q.lane && !list(q.lane).includes(lead.lane ?? '')) return false
  if (q.batch && lead.batch !== q.batch) return false
  if (q.city && lead.city !== q.city) return false
  if (q.state && lead.state !== q.state.toUpperCase()) return false
  if (q.issue && !lead.siteIssues.includes(q.issue)) return false
  if (q.hasEmail === 'true' && !lead.bestEmail) return false
  if (q.hasEmail === 'false' && lead.bestEmail) return false
  if (q.minAttempts && lead.attempts < Number(q.minAttempts)) return false
  if (q.maxAttempts && lead.attempts > Number(q.maxAttempts)) return false
  if (q.olderThanDays && new Date(lead.createdAt ?? 0).getTime() > t - Number(q.olderThanDays) * DAY) return false
  if (q.notCalledSinceDays) {
    if (!lead.lastCalledAt || new Date(lead.lastCalledAt).getTime() > t - Number(q.notCalledSinceDays) * DAY) return false
  }
  if (q.search) {
    const term = q.search.toLowerCase()
    const digits = q.search.replace(/\D/g, '')
    const hit = lead.businessName.toLowerCase().includes(term) || (digits.length >= 3 && lead.phone.includes(digits))
    if (!hit) return false
  }
  return true
}

// Due callbacks first, then never-attempted leads, then the fewest attempts.
function queueOrder(a: DemoLead, b: DemoLead): number {
  const due = (l: DemoLead) => (l.nextCallbackAt ? new Date(l.nextCallbackAt).getTime() : Number.POSITIVE_INFINITY)
  return due(a) - due(b) || a.attempts - b.attempts || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)
}

const publicLead = (lead: DemoLead) => {
  const { orgId: _orgId, claimed: _claimed, ...rest } = lead
  return { ...rest, notes: [...lead.notes] }
}

export function queue(q: LeadFilters): QueueResponse {
  const { org, leads } = data()
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200)
  const offset = Math.max(Number(q.offset) || 0, 0)
  const matching = leads.filter((l) => matches(l, q)).sort(queueOrder)
  const caller = org.callers.find((c) => c.username === DEMO_USER.username)
  return {
    callWindow: callWindow(),
    callerName: caller?.displayName ?? DEMO_USER.displayName,
    callbackNumber: org.callerId,
    companyName: org.companyName,
    total: matching.length,
    offset,
    limit,
    leads: matching.slice(offset, offset + limit).map(publicLead),
  }
}

export function facets(): Facets {
  const { leads } = data()
  const distinct = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => Boolean(v)))].sort()
  const statuses = new Map<string, number>()
  for (const l of leads) statuses.set(l.status, (statuses.get(l.status) ?? 0) + 1)
  return {
    cities: distinct(leads.map((l) => l.city)),
    states: distinct(leads.map((l) => l.state)),
    lanes: distinct(leads.map((l) => l.lane)),
    batches: distinct(leads.map((l) => l.batch)).reverse(),
    issues: distinct(leads.flatMap((l) => l.siteIssues)),
    statuses: [...statuses].sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => ({ status, count })),
    archivedCount: leads.filter((l) => l.archivedAt).length,
    total: leads.length,
  }
}

function leadOrFail(id: string): DemoLead {
  return data().leads.find((l) => l.id === id) ?? fail('lead not found')
}

function history(leadId: string): CallHistoryEntry[] {
  return data()
    .calls.filter((c) => c.leadId === leadId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 20)
    .map((c) => ({
      id: c.id,
      attemptNumber: c.attemptNumber,
      startedAt: c.startedAt,
      answeredAt: c.answeredAt,
      duration: c.duration,
      dialStatus: c.dialStatus,
      disposition: c.disposition,
      dispositionLabel: c.dispositionLabel,
      username: c.username,
      direction: c.direction,
      handledBy: c.handledBy,
    }))
}

export function leadDetail(id: string): LeadDetail {
  return { lead: publicLead(leadOrFail(id)), calls: history(id) }
}

export function archive(id: string, reason?: string) {
  const lead = leadOrFail(id)
  lead.archivedAt = new Date().toISOString()
  lead.archivedReason = reason?.trim() || 'archived manually'
  return { lead: publicLead(lead) }
}

export function restore(id: string) {
  const lead = leadOrFail(id)
  lead.archivedAt = null
  lead.archivedReason = null
  return { lead: publicLead(lead) }
}

export function remove(id: string) {
  const d = data()
  leadOrFail(id)
  const before = d.calls.length
  d.calls = d.calls.filter((c) => c.leadId !== id)
  d.leads = d.leads.filter((l) => l.id !== id)
  return { deleted: true as const, callsDeleted: before - d.calls.length }
}

export function bulkArchive(filter: LeadFilters, expectedCount: number, reason?: string) {
  const matching = data().leads.filter((l) => !l.archivedAt && matches(l, { ...filter, view: filter.view ?? 'all' }))
  if (matching.length !== expectedCount) fail(`filter now matches ${matching.length} leads, not ${expectedCount}. Re-check and retry.`)
  const at = new Date().toISOString()
  for (const lead of matching) {
    lead.archivedAt = at
    lead.archivedReason = reason?.trim() || 'bulk archived'
  }
  return { archived: matching.length }
}

export function recycle(): never {
  return fail('Demo: no lead has rested long enough to move yet')
}

export function noTwilio(): never {
  return fail('Demo mode: no Twilio account is connected, so no real calls are placed')
}

const DISPOSITION_TO_STATUS: Record<Disposition, LeadStatus> = {
  connected: 'contacted',
  voicemail: 'contacted',
  no_answer: 'contacted',
  busy: 'contacted',
  wrong_number: 'lost',
  not_interested: 'lost',
  callback_later: 'callback',
  interested: 'callback',
  booked: 'booked',
  do_not_call: 'dnc',
  hung_up: 'contacted',
  other: 'contacted',
}
const RETRYABLE: Disposition[] = ['no_answer', 'voicemail', 'busy', 'hung_up', 'other']
const MAX_ATTEMPTS = 5

export function disposition(
  id: string,
  body: { disposition: Disposition; dispositionLabel?: string; note?: string; callbackAt?: string; callSid?: string },
) {
  const lead = leadOrFail(id)
  const label = body.disposition === 'other' ? body.dispositionLabel?.trim().slice(0, 80) : undefined
  if (body.disposition === 'other' && !label) fail('an "other" outcome needs a label')
  lead.lastDisposition = body.disposition
  lead.lastDispositionLabel = label ?? null
  lead.status = DISPOSITION_TO_STATUS[body.disposition]
  lead.lastCalledAt = new Date().toISOString()
  if (body.disposition === 'do_not_call') lead.doNotCall = true
  if (body.callbackAt) lead.nextCallbackAt = new Date(body.callbackAt).toISOString()
  else if (RETRYABLE.includes(body.disposition)) {
    if (lead.attempts >= MAX_ATTEMPTS) {
      lead.status = 'lost'
      lead.nextCallbackAt = null
      lead.notes.push({ body: `Auto-closed after ${lead.attempts} attempts without a result.`, author: 'system', at: new Date().toISOString() })
    } else {
      lead.nextCallbackAt = new Date(Date.now() + 3 * DAY).toISOString()
    }
  } else if (body.disposition !== 'callback_later' && body.disposition !== 'interested') {
    lead.nextCallbackAt = null
  }
  if (body.note?.trim()) lead.notes.push({ body: body.note.trim(), author: DEMO_USER.username, at: new Date().toISOString() })
  const call = data().calls.find((c) => c.parentCallSid === body.callSid && c.leadId === id)
  if (call) {
    call.disposition = body.disposition
    call.dispositionLabel = label ?? null
  }
  return { lead: publicLead(lead) }
}

export function updateLead(id: string, body: { status?: string; doNotCall?: boolean; note?: string }) {
  const lead = leadOrFail(id)
  if (body.status) lead.status = body.status as LeadStatus
  if (typeof body.doNotCall === 'boolean') {
    lead.doNotCall = body.doNotCall
    if (body.doNotCall) lead.status = 'dnc'
  }
  if (body.note?.trim()) lead.notes.push({ body: body.note.trim(), author: DEMO_USER.username, at: new Date().toISOString() })
  return { lead: publicLead(lead) }
}

export function batches() {
  const counts = new Map<string, number>()
  for (const l of data().leads) if (l.batch) counts.set(l.batch, (counts.get(l.batch) ?? 0) + 1)
  return { batches: [...counts].sort(([a], [b]) => b.localeCompare(a)).map(([batch, count]) => ({ batch, count })) }
}

// --- import --------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell.trim())
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell.trim())
      if (row.some(Boolean)) rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell.trim())
  if (row.some(Boolean)) rows.push(row)
  return rows
}

function e164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

export async function importCsv(file: File, batch?: string): Promise<ImportResult> {
  const d = data()
  const [header = [], ...rows] = parseCsv(await file.text())
  const key = (h: string) => h.toLowerCase().replace(/[\s\-.]+/g, '_')
  const col = (...names: string[]) => header.findIndex((h) => names.includes(key(h)))
  const phoneCol = col('phone', 'phone_number', 'telephone', 'tel', 'mobile', 'number')
  const nameCol = col('business_name', 'name', 'company', 'business', 'company_name')
  const cityCol = col('city', 'town')
  const stateCol = col('state', 'province', 'region')
  const dncCol = col('do_not_contact', 'do_not_call', 'dnc', 'opt_out')
  const result: ImportResult = {
    batch: batch || file.name.replace(/\.csv$/i, ''),
    totalRows: rows.length,
    imported: 0,
    updated: 0,
    skippedNoPhone: 0,
    skippedBadPhone: 0,
    duplicatesInFile: 0,
    skippedOwnedElsewhere: 0,
    skippedDoNotCall: 0,
    errors: [],
  }
  if (phoneCol < 0) {
    result.errors.push(`No phone column found. Found columns: ${header.join(', ')}`)
    return result
  }
  const seen = new Set<string>()
  rows.forEach((row, index) => {
    const raw = row[phoneCol] ?? ''
    if (!raw) return void result.skippedNoPhone++
    const phone = e164(raw)
    if (!phone) {
      result.skippedBadPhone++
      if (result.errors.length < 10) result.errors.push(`Row ${index + 2}: unparseable phone "${raw}"`)
      return
    }
    if (seen.has(phone)) return void result.duplicatesInFile++
    seen.add(phone)
    if (dncCol >= 0 && /^(yes|true|1)$/i.test(row[dncCol] ?? '')) return void result.skippedDoNotCall++
    const existing = d.leads.find((l) => l.phone === phone)
    if (existing) return void result.updated++
    const state = (row[stateCol] ?? '').toUpperCase() || null
    d.leads.push({
      orgId: d.org.id,
      claimed: true,
      id: `65c3c0de${(Date.now() + index).toString(16).padStart(16, '0').slice(-16)}`,
      phone,
      phoneDisplay: formatPhone(phone),
      businessName: row[nameCol] || phone,
      website: null,
      bestEmail: null,
      ownerName: null,
      ownerLabel: null,
      askForName: null,
      askForRole: null,
      askForNote: null,
      address: null,
      category: null,
      rating: null,
      reviewCount: null,
      siteQualityScore: null,
      siteYear: null,
      sitePlatform: null,
      siteIssues: [],
      hookSnippet: null,
      googleMapsUrl: null,
      lane: null,
      city: row[cityCol] || null,
      state,
      status: 'new',
      doNotCall: false,
      attempts: 0,
      lastCalledAt: null,
      lastDisposition: null,
      lastDispositionLabel: null,
      nextCallbackAt: null,
      notes: [],
      batch: result.batch,
      archivedAt: null,
      archivedReason: null,
      createdAt: new Date().toISOString(),
      recordingAllowed: Boolean(state && DEMO_TRANSCRIBE_STATES.includes(state)),
    })
    result.imported++
  })
  return result
}

// --- metrics -------------------------------------------------------------------

type Outcome = 'talked' | 'voicemail' | 'not_reached' | 'unlabeled'
const TALKED: Disposition[] = ['connected', 'interested', 'callback_later', 'booked', 'not_interested', 'do_not_call', 'hung_up']

// The server's OUTCOME_OF: only the caller's disposition says whether a person was on the line.
function outcomeOf(c: DemoCall): Outcome {
  if (c.disposition && TALKED.includes(c.disposition)) return 'talked'
  if (c.disposition === 'voicemail') return 'voicemail'
  if (c.disposition === 'other') return c.dialStatus === 'completed' ? 'talked' : 'not_reached'
  if (c.disposition) return 'not_reached'
  return c.dialStatus === 'completed' ? 'unlabeled' : 'not_reached'
}

function groupBy<K>(calls: DemoCall[], key: (c: DemoCall) => K) {
  const groups = new Map<K, DemoCall[]>()
  for (const c of calls) groups.set(key(c), [...(groups.get(key(c)) ?? []), c])
  return [...groups]
}

const count = (calls: DemoCall[], outcome: Outcome) => calls.filter((c) => outcomeOf(c) === outcome).length
const talkSeconds = (calls: DemoCall[]) => calls.reduce((n, c) => n + (outcomeOf(c) === 'talked' ? c.duration : 0), 0)

export function stats(days: number): StatsOverview {
  const d = data()
  const span = Math.min(days || 14, 90)
  const since = Date.now() - span * DAY
  const inWindow = d.calls.filter((c) => new Date(c.startedAt).getTime() >= since)
  const outbound = inWindow.filter((c) => c.direction !== 'inbound')
  const inbound = inWindow.filter((c) => c.direction === 'inbound')
  const hourOf = (iso: string) =>
    Number(new Intl.DateTimeFormat('en-US', { timeZone: DEMO_TIME_ZONE, hour12: false, hour: '2-digit' }).format(new Date(iso))) % 24
  const billed = outbound.reduce((n, c) => n + c.duration, 0)
  const minutes = outbound.length ? Math.ceil(billed / outbound.length / 60) * outbound.length : 0
  const statuses = new Map<string, number>()
  for (const l of d.leads.filter((x) => x.claimed)) statuses.set(l.status, (statuses.get(l.status) ?? 0) + 1)

  return {
    days: span,
    totalLeads: d.leads.filter((l) => l.claimed).length,
    summary: {
      calls: outbound.length,
      talked: count(outbound, 'talked'),
      voicemail: count(outbound, 'voicemail'),
      notReached: count(outbound, 'not_reached'),
      unlabeled: count(outbound, 'unlabeled'),
      talkRate: outbound.length ? count(outbound, 'talked') / outbound.length : 0,
      talkSeconds: talkSeconds(outbound),
      estimatedCostUsd: Number((minutes * 0.018).toFixed(2)),
    },
    byDay: groupBy(outbound, (c) => c.startedAt.slice(0, 10))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, calls]) => ({ date, calls: calls.length, talked: count(calls, 'talked'), voicemail: count(calls, 'voicemail'), talkSeconds: talkSeconds(calls) })),
    byHour: groupBy(outbound, (c) => hourOf(c.startedAt))
      .sort(([a], [b]) => a - b)
      .map(([hour, calls]) => ({ hour, calls: calls.length, talked: count(calls, 'talked'), voicemail: count(calls, 'voicemail') })),
    byAttempt: groupBy(outbound.filter((c) => c.attemptNumber !== null), (c) => c.attemptNumber!)
      .sort(([a], [b]) => a - b)
      .map(([attempt, calls]) => ({ attempt, calls: calls.length, talked: count(calls, 'talked'), voicemail: count(calls, 'voicemail') })),
    byDisposition: groupBy(
      outbound.filter((c) => c.disposition),
      (c) => (c.disposition === 'other' ? `other: ${(c.dispositionLabel ?? '').toLowerCase()}` : c.disposition!),
    )
      .map(([disposition, calls]) => ({ disposition, count: calls.length }))
      .sort((a, b) => b.count - a.count),
    byStatus: [...statuses].map(([status, n]) => ({ status, count: n })).sort((a, b) => b.count - a.count),
    byCaller: groupBy(outbound, (c) => c.username ?? '')
      .map(([username, calls]) => ({ username, calls: calls.length, talked: count(calls, 'talked'), talkSeconds: talkSeconds(calls) }))
      .sort((a, b) => b.calls - a.calls),
    inbound: {
      total: inbound.length,
      ai: inbound.filter((c) => c.handledBy === 'ai').length,
      human: inbound.filter((c) => c.handledBy === 'human').length,
      missed: inbound.filter((c) => c.handledBy === 'missed').length,
      aiSeconds: inbound.filter((c) => c.handledBy === 'ai').reduce((n, c) => n + c.duration, 0),
    },
  }
}

// --- transcripts ---------------------------------------------------------------

const leadOf = (c: DemoCall) => (c.leadId ? (data().leads.find((l) => l.id === c.leadId) ?? null) : null)
const businessOf = (c: DemoCall) => leadOf(c)?.businessName ?? c.aiSummary?.business ?? null
const displayPhone = (c: DemoCall) => {
  const phone = leadOf(c)?.phone ?? c.fromNumber
  return phone ? formatPhone(phone) : null
}

function snippetOf(c: DemoCall, term: string): TranscriptRow['snippet'] {
  const lines = c.transcript?.lines ?? []
  const needle = term.toLowerCase()
  const pick =
    (needle && lines.find((l) => l.text.toLowerCase().includes(needle))) ||
    lines.find((l) => l.speaker === 'lead' && l.text.trim().length > 3) ||
    lines[0]
  if (!pick) return c.transcript ? { speaker: null, text: c.transcript.text.slice(0, 160) } : null
  const at = needle ? pick.text.toLowerCase().indexOf(needle) : -1
  return { speaker: pick.speaker, text: at < 60 ? pick.text.slice(0, 160) : `…${pick.text.slice(at - 50, at + 110)}` }
}

function sortCalls<T extends string>(calls: DemoCall[], sort: T, dir: 'asc' | 'desc', keyOf: (c: DemoCall, sort: T) => string | number) {
  const sign = dir === 'asc' ? 1 : -1
  return [...calls].sort((a, b) => {
    const x = keyOf(a, sort)
    const y = keyOf(b, sort)
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    return sign * (order || a.id.localeCompare(b.id))
  })
}

const PAGE_SIZES = [10, 25, 50]

export function transcripts(q: TranscriptQuery): TranscriptPage {
  const d = data()
  const limit = PAGE_SIZES.includes(Number(q.limit)) ? Number(q.limit) : 10
  const offset = Math.max(Math.floor(Number(q.offset) || 0), 0)
  const term = q.search?.trim().slice(0, 100) ?? ''
  const failedView = q.status === 'failed'
  const since = Number(q.days) > 0 ? Date.now() - Number(q.days) * DAY : 0

  const matching = d.calls.filter((c) => {
    if (failedView ? c.transcript || !c.transcriptError : !c.transcript) return false
    if (q.direction === 'inbound' && c.direction !== 'inbound') return false
    if (q.direction === 'outbound' && c.direction === 'inbound') return false
    if (q.caller && c.username !== q.caller) return false
    if (q.outcome === 'none' ? c.disposition !== null : q.outcome && c.disposition !== q.outcome) return false
    if (Number(q.minSeconds) > 0 && c.duration < Number(q.minSeconds)) return false
    if (since && new Date(c.startedAt).getTime() < since) return false
    if (q.real === '1' && (c.disposition === 'voicemail' || c.duration < 30)) return false
    if (term) {
      const t = term.toLowerCase()
      const digits = term.replace(/\D/g, '')
      const lead = leadOf(c)
      const hit =
        c.transcript?.text.toLowerCase().includes(t) ||
        lead?.businessName.toLowerCase().includes(t) ||
        c.aiSummary?.business?.toLowerCase().includes(t) ||
        c.aiSummary?.name?.toLowerCase().includes(t) ||
        (digits.length >= 3 && ((lead?.phone ?? '').includes(digits) || (c.fromNumber ?? '').includes(digits)))
      if (!hit) return false
    }
    return true
  })

  const sorted = sortCalls(matching, q.sort, q.dir, (c, sort) => {
    if (sort === 'business') return (businessOf(c) ?? '').toLowerCase()
    if (sort === 'caller') return c.username ?? ''
    if (sort === 'attempt') return c.attemptNumber ?? 0
    if (sort === 'duration') return c.duration
    if (sort === 'outcome') return c.disposition ?? ''
    return new Date(c.startedAt).getTime()
  })

  return {
    total: sorted.length,
    offset,
    limit,
    callers: [...new Set(d.calls.filter((c) => c.direction !== 'inbound' && c.username).map((c) => c.username!))].sort(),
    rows: sorted.slice(offset, offset + limit).map((c) => ({
      id: c.id,
      startedAt: c.startedAt,
      duration: c.duration,
      direction: c.direction,
      handledBy: c.handledBy,
      username: c.username,
      attemptNumber: c.attemptNumber,
      disposition: c.disposition,
      dispositionLabel: c.dispositionLabel,
      businessName: businessOf(c),
      phone: displayPhone(c),
      lineCount: c.transcript?.lines.length ?? 0,
      snippet: snippetOf(c, term),
      error: c.transcriptError,
    })),
  }
}

export function transcript(id: string): TranscriptDetail {
  const c = data().calls.find((x) => x.id === id) ?? fail('call not found')
  const lead = leadOf(c)
  return {
    id: c.id,
    leadId: lead?.id ?? null,
    businessName: businessOf(c),
    phone: displayPhone(c),
    place: [lead?.city, lead?.state].filter(Boolean).join(', ') || null,
    startedAt: c.startedAt,
    answeredAt: c.answeredAt,
    duration: c.duration,
    direction: c.direction,
    handledBy: c.handledBy,
    username: c.username,
    attemptNumber: c.attemptNumber,
    disposition: c.disposition,
    dispositionLabel: c.dispositionLabel,
    aiSummary: c.aiSummary,
    transcript: c.transcript,
    error: c.transcriptError,
    quality: c.quality,
  }
}

// --- callbacks -----------------------------------------------------------------

export function callbacks(q: CallbackQuery): CallbackPage {
  const d = data()
  const limit = PAGE_SIZES.includes(Number(q.limit)) ? Number(q.limit) : 10
  const offset = Math.max(Math.floor(Number(q.offset) || 0), 0)
  const since = Number(q.days) > 0 ? Date.now() - Number(q.days) * DAY : 0
  const term = q.search?.trim().toLowerCase() ?? ''
  const inbound = d.calls.filter((c) => c.direction === 'inbound')

  const matching = inbound.filter((c) => {
    if (q.handledBy && c.handledBy !== q.handledBy) return false
    if (q.who === 'lead' && !c.leadId) return false
    if (q.who === 'unknown' && c.leadId) return false
    if (q.who === 'test') return false
    if (since && new Date(c.startedAt).getTime() < since) return false
    if (term) {
      const lead = leadOf(c)
      const s = c.aiSummary
      const text = [lead?.businessName, lead?.ownerName, lead?.city, s?.name, s?.business, s?.reason, s?.notes, s?.email, s?.bestTime, c.transcript?.text]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      const digits = term.replace(/\D/g, '')
      if (!text.includes(term) && !(digits.length >= 3 && (c.fromNumber ?? '').includes(digits))) return false
    }
    return true
  })

  const sorted = sortCalls(matching, q.sort, q.dir, (c, sort) => {
    if (sort === 'business') return (businessOf(c) ?? '').toLowerCase()
    if (sort === 'handledBy') return c.handledBy ?? ''
    if (sort === 'duration') return c.duration
    if (sort === 'status') return leadOf(c)?.status ?? ''
    return new Date(c.startedAt).getTime()
  })

  return {
    total: sorted.length,
    offset,
    limit,
    leadTimeZone: DEMO_TIME_ZONE,
    rows: sorted.slice(offset, offset + limit).map((c) => {
      const lead = leadOf(c)
      const prior = d.calls
        .filter((x) => x.direction !== 'inbound' && x.leadId && x.leadId === c.leadId && x.startedAt < c.startedAt)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      const said = c.transcript?.lines.find((l) => l.speaker === 'lead' && l.text.trim().length > 3)?.text
      const last = prior[0]
      return {
        id: c.id,
        startedAt: c.startedAt,
        duration: c.duration,
        handledBy: c.handledBy ?? 'missed',
        reason: c.inboundReason,
        phone: c.fromNumber ? formatPhone(c.fromNumber) : null,
        isTest: false,
        timesCalled: inbound.filter((x) => x.fromNumber === c.fromNumber).length || 1,
        lead: lead
          ? {
              id: lead.id,
              businessName: lead.businessName,
              ownerName: lead.ownerName,
              place: [lead.city, lead.state].filter(Boolean).join(', ') || null,
              status: lead.status,
              doNotCall: lead.doNotCall,
            }
          : null,
        aiSummary: c.aiSummary,
        ourCalls: prior.length,
        lastOutbound: last
          ? { startedAt: last.startedAt, disposition: last.disposition, dispositionLabel: last.dispositionLabel, username: last.username }
          : null,
        snippet: said ? said.slice(0, 160) : (c.transcript?.text.slice(0, 160) ?? null),
        hasTranscript: Boolean(c.transcript),
      }
    }),
  }
}

// --- the simulated phone ---------------------------------------------------------

const randomHex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')

export function startCall(phone: string): string {
  const d = data()
  const lead = d.leads.find((l) => l.phone === phone && l.claimed) ?? fail('That number is not in the lead list.')
  lead.attempts++
  lead.lastCalledAt = new Date().toISOString()
  const sid = `CA${randomHex(32)}`
  d.calls.push({
    id: randomHex(24),
    orgId: d.org.id,
    direction: 'outbound',
    leadId: lead.id,
    username: DEMO_USER.username,
    attemptNumber: lead.attempts,
    startedAt: new Date().toISOString(),
    answeredAt: null,
    endedAt: null,
    duration: 0,
    dialStatus: 'initiated',
    disposition: null,
    dispositionLabel: null,
    handledBy: null,
    inboundReason: null,
    fromNumber: null,
    parentCallSid: sid,
    aiSummary: null,
    transcript: null,
    transcriptError: null,
    quality: null,
  })
  return sid
}

const callBySid = (sid: string) => data().calls.find((c) => c.parentCallSid === sid)

export function answerCall(sid: string): void {
  const call = callBySid(sid)
  if (!call) return
  call.answeredAt = new Date().toISOString()
  call.dialStatus = 'answered'
}

export function endCall(sid: string, seconds: number): void {
  const call = callBySid(sid)
  if (!call) return
  call.endedAt = new Date().toISOString()
  call.duration = seconds
  call.dialStatus = call.answeredAt ? 'completed' : 'canceled'
  if (call.answeredAt) {
    call.quality = { avgMos: 4.3, outLossPct: 0.2, maxOutLossPct: 1.1, voiceDb: -24.6, voiceFloorDb: -53.2, voicePeakDb: -4.8, codec: 'opus', mic: 'USB Headset' }
  }
}

export function callStatus(sid: string): CallStatus {
  const call = callBySid(sid) ?? fail('call not found')
  return { callSid: sid, dialStatus: call.dialStatus, answeredAt: call.answeredAt, endedAt: call.endedAt, duration: call.duration }
}

// The in-browser transcriber's output for a demo call: a canned, fictional conversation.
export function transcribeDemoCall(sid: string): boolean {
  const call = callBySid(sid)
  const lead = call && leadOf(call)
  if (!call || !lead || !lead.recordingAllowed) return false
  const caller = data().org.callers.find((c) => c.username === DEMO_USER.username)?.displayName ?? DEMO_USER.displayName
  call.transcript = demoConversation(lead, caller, data().org.companyName, 'interested')
  return true
}

export function recordInbound(from: string, handledBy: 'human' | 'ai', seconds: number): void {
  const d = data()
  const lead = d.leads.find((l) => l.phone === from) ?? null
  const person = d.org.callers[0]!.displayName
  const lines: TranscriptLine[] = [
    { speaker: 'ai', start: 0, text: `Hi, this is Ava, ${person}'s AI assistant at ${d.org.companyName} ${person} can't pick up right now. Who am I speaking with?` },
    { speaker: 'lead', start: 5.6, text: 'Hi, I missed a call from this number earlier.' },
    { speaker: 'ai', start: 9.3, text: `Thanks for calling back. I'll pass a written note of this call to ${person} so they have everything. When is a good time for a call back?` },
    { speaker: 'lead', start: 17.8, text: 'This afternoon works.' },
  ]
  d.calls.push({
    id: randomHex(24),
    orgId: d.org.id,
    direction: 'inbound',
    leadId: lead?.id ?? null,
    username: null,
    attemptNumber: null,
    startedAt: new Date(Date.now() - seconds * 1000).toISOString(),
    answeredAt: new Date(Date.now() - seconds * 1000).toISOString(),
    endedAt: new Date().toISOString(),
    duration: seconds,
    dialStatus: 'completed',
    disposition: null,
    dispositionLabel: null,
    handledBy,
    inboundReason: handledBy === 'ai' ? 'completed' : null,
    fromNumber: from,
    parentCallSid: `CA${randomHex(32)}`,
    aiSummary: handledBy === 'ai' ? { reason: 'returning our call', bestTime: 'this afternoon', flags: [] } : null,
    transcript:
      handledBy === 'ai'
        ? { text: lines.map((l) => `${l.speaker === 'ai' ? 'AI' : 'Them'}: ${l.text}`).join('\n'), lines, model: 'azure-voice-live', processingSeconds: null }
        : null,
    transcriptError: null,
    quality: null,
  })
  if (lead) {
    lead.notes.push({ body: handledBy === 'ai' ? 'Called us back, the AI receptionist took it.' : `Called us back, answered in the browser (${seconds}s).`, author: 'receptionist', at: new Date().toISOString() })
  }
}
