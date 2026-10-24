import { timingSafeEqual } from 'node:crypto'
import { env } from '../config/env.js'
import { Call, INBOUND_HANDLERS } from '../models/Call.js'
import { Lead } from '../models/Lead.js'
import { loadOrgByCallerId } from '../lib/orgs.js'
import { safeRouter } from '../lib/safeRouter.js'
import { suppress } from '../lib/suppression.js'

export const inboundRouter = safeRouter()

const MAX_LINES = 400
const MAX_LINE_CHARS = 2000
const MAX_FIELD_CHARS = 500
const SUMMARY_FIELDS = ['name', 'business', 'callbackNumber', 'bestTime', 'reason', 'email', 'notes'] as const
// Leads in these states are finished business: a callback adds a note but never reopens them.
const TERMINAL = new Set(['won', 'booked'])

type Line = { speaker: 'lead' | 'ai'; start: number; text: string }

function authorized(header: string | undefined): boolean {
  const secret = env.inbound.sharedSecret
  const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
  if (!secret || !token) return false
  const a = Buffer.from(token)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

const str = (v: unknown, max = MAX_FIELD_CHARS) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

const date = (v: unknown) => {
  const d = typeof v === 'string' ? new Date(v) : null
  return d && !Number.isNaN(d.getTime()) ? d : undefined
}

function cleanLines(raw: unknown): Line[] {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, MAX_LINES)
    .filter((l) => (l?.speaker === 'lead' || l?.speaker === 'ai') && typeof l.text === 'string' && l.text.trim())
    .map((l) => ({ speaker: l.speaker, start: Number(l.start) || 0, text: String(l.text).trim().slice(0, MAX_LINE_CHARS) }))
}

function cleanSummary(raw: unknown) {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of SUMMARY_FIELDS) {
    const v = str(r[k])
    if (v) out[k] = v
  }
  out.flags = Array.isArray(r.flags) ? r.flags.map((f) => str(f, 40)).filter(Boolean).slice(0, 20) : []
  return out as { flags: string[] } & Partial<Record<(typeof SUMMARY_FIELDS)[number], string>>
}

function noteFor(handledBy: string, reason: string | undefined, seconds: number, s?: ReturnType<typeof cleanSummary>): string {
  if (handledBy === 'human') return `Called us back, answered in the browser (${seconds}s).`
  if (handledBy === 'missed') return `Called us back and was missed (${reason ?? 'no answer'}). Call them back.`
  const parts = [`Called us back, the AI receptionist took it (${seconds}s).`]
  if (s?.name) parts.push(`Name: ${s.name}.`)
  if (s?.reason) parts.push(`Reason: ${s.reason}.`)
  if (s?.bestTime) parts.push(`Call back: ${s.bestTime}.`)
  if (s?.callbackNumber) parts.push(`Number: ${s.callbackNumber}.`)
  if (s?.email) parts.push(`Email: ${s.email}.`)
  if (s?.notes) parts.push(`Notes: ${s.notes}.`)
  if (s?.flags.length) parts.push(`Flags: ${s.flags.join(', ')}.`)
  return parts.join(' ')
}

// POST /api/inbound/ingest — the receptionist worker reports every finished inbound call.
// Redelivery is expected (it retries while a free-tier host sleeps), so the call upsert is keyed by
// CallSid and lead side effects only run the first time a call is seen.
inboundRouter.post('/ingest', async (req, res) => {
  if (!env.inbound.sharedSecret) {
    res.status(503).json({ error: 'inbound ingest not configured' })
    return
  }
  if (!authorized(req.get('authorization'))) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }

  const b = (req.body ?? {}) as Record<string, unknown>
  const callSid = typeof b.callSid === 'string' && /^CA[0-9a-f]{32}$/i.test(b.callSid) ? b.callSid : null
  const handledBy = INBOUND_HANDLERS.find((h) => h === b.handledBy)
  if (!callSid || !handledBy) {
    res.status(400).json({ error: 'callSid and handledBy are required' })
    return
  }

  // The number that rang decides the workspace; each workspace has its own. The worker's
  // `org` must agree when it sends one (payloads queued before workspaces carry none).
  const to = str(b.to, 32)
  const org = to ? await loadOrgByCallerId(to) : null
  if (!org || (typeof b.org === 'string' && b.org !== org.slug)) {
    res.status(422).json({ error: 'no workspace owns that number' })
    return
  }
  const orgId = org.id

  // The worker's call state lives in eventually-consistent KV, so a status callback can
  // race the real outcome and report "missed" for a call that was answered. Never downgrade.
  if (handledBy === 'missed') {
    const existing = await Call.findOne({ orgId, parentCallSid: callSid, direction: 'inbound' }, { handledBy: 1 })
    if (existing && existing.handledBy !== 'missed') {
      res.json({ ok: true, firstDelivery: false, ignored: 'already answered' })
      return
    }
  }

  const from = str(b.from, 32)
  const startedAt = date(b.startedAt) ?? new Date()
  const seconds = Math.min(Math.max(Math.round(Number(b.durationSeconds) || 0), 0), 24 * 3600)
  const lines = cleanLines((b.transcript as { lines?: unknown } | null)?.lines)
  const summary = handledBy === 'ai' ? cleanSummary(b.aiSummary) : undefined
  const reason = str(b.reason, 60)
  // A phone can have one document per tenure in this workspace; the one it owns now comes first.
  const lead = from ? await Lead.findOne({ orgId, phone: from }).sort({ claimed: -1, createdAt: -1 }) : null

  const set: Record<string, unknown> = {
    direction: 'inbound',
    handledBy,
    inboundReason: reason,
    fromNumber: from,
    to,
    startedAt,
    endedAt: date(b.endedAt),
    duration: seconds,
    dialStatus: handledBy === 'missed' ? 'no-answer' : 'completed',
    ...(lead ? { leadId: lead._id } : {}),
    ...(summary ? { aiSummary: summary } : {}),
    ...(lines.length
      ? {
          transcript: {
            text: lines.map((l) => `${l.speaker === 'ai' ? 'AI' : 'Them'}: ${l.text}`).join('\n'),
            lines,
            model: 'azure-voice-live',
            createdAt: new Date(),
          },
        }
      : {}),
  }

  // orgId in the filter is copied onto an inserted row, like parentCallSid.
  const result = await Call.findOneAndUpdate(
    { orgId, parentCallSid: callSid, direction: 'inbound' },
    { $set: set, $setOnInsert: { parentCallSid: callSid } },
    { upsert: true, new: true, includeResultMetadata: true },
  )
  const firstDelivery = !result.lastErrorObject?.updatedExisting

  if (from && firstDelivery && summary?.flags.includes('do_not_call')) {
    await suppress(from, { reason: 'asked the receptionist', source: 'receptionist', orgId })
  }

  // A lead this workspace no longer owns (moved to another workspace) keeps the call in its
  // history but is never reopened here.
  if (lead?.claimed && firstDelivery) {
    lead.notes.push({ body: noteFor(handledBy, reason, seconds, summary), author: 'receptionist', at: new Date() })
    if (summary?.flags.includes('do_not_call')) {
      lead.doNotCall = true
      lead.status = 'dnc'
      lead.nextCallbackAt = undefined
    } else if (handledBy !== 'human' && !lead.doNotCall && !TERMINAL.has(lead.status)) {
      // They rang back: put them at the top of the queue, even if they had been closed out.
      lead.status = 'callback'
      lead.nextCallbackAt = new Date()
      lead.archivedAt = undefined
      lead.archivedReason = undefined
    }
    await lead.save()
  }

  res.json({ ok: true, firstDelivery, leadMatched: Boolean(lead) })
})
