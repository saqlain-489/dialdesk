import type { Request } from 'express'
import { Types, isValidObjectId } from 'mongoose'
import { Call } from '../models/Call.js'
import { DISPOSITIONS, LEAD_STATUSES, Lead, type Disposition } from '../models/Lead.js'
import { checkCallWindow } from '../lib/callWindow.js'
import { formatForDisplay } from '../lib/phone.js'
import { isRetryable, planRetry } from '../lib/retry.js'
import { recycleLead, recyclableFilter, repairPendingRecycles, type RecycleOutcome } from '../lib/recycle.js'
import { safeRouter } from '../lib/safeRouter.js'
import { liftSuppression, suppress } from '../lib/suppression.js'
import { env } from '../config/env.js'
import { requireOwner } from '../auth.js'
import { Organization } from '../models/Organization.js'
import { User } from '../models/User.js'

export const leadsRouter = safeRouter()

const orgIdOf = (req: Request) => req.org!.id

// A malformed id would otherwise throw a CastError; to the caller it is simply not there.
const leadKey = (req: Request) => (isValidObjectId(req.params.id) ? { _id: req.params.id, orgId: orgIdOf(req) } : null)

// A disposition is what happened on the call; this maps it to where the lead
// lands in the pipeline so the caller only has to make one choice.
const DISPOSITION_TO_STATUS: Record<Disposition, string> = {
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

const ACTIVE_QUEUE_FILTER = {
  doNotCall: { $ne: true },
  archivedAt: { $exists: false },
  status: { $nin: ['dnc', 'won', 'lost', 'booked'] },
}

type LeadQuery = Record<string, unknown>

/**
 * Shared filter builder for the dialer queue and the admin lead browser.
 *
 * `view` decides the baseline: `queue` is what is actually callable right now,
 * `archived` is the recycling bin, and `all` ignores both so an admin can find a
 * lead by name regardless of what state it ended up in.
 */
function buildLeadFilter(orgId: Types.ObjectId, q: Record<string, string | undefined>): LeadQuery {
  const view = q.view ?? 'queue'
  const filter: LeadQuery =
    view === 'queue'
      ? { orgId, claimed: true, ...ACTIVE_QUEUE_FILTER }
      : view === 'archived'
        ? { orgId, archivedAt: { $exists: true } }
        : view === 'recyclable'
          ? recyclableFilter(orgId)
          : { orgId }

  if (q.status) filter.status = { $in: q.status.split(',').map((s) => s.trim()).filter(Boolean) }
  if (q.batch) filter.batch = q.batch
  if (q.lane) filter.lane = { $in: q.lane.split(',').map((s) => s.trim()).filter(Boolean) }
  if (q.city) filter.city = q.city
  if (q.state) filter.state = q.state.toUpperCase()
  if (q.issue) filter.siteIssues = q.issue
  if (q.doNotCall === 'true') filter.doNotCall = true

  if (q.hasEmail === 'true') filter.bestEmail = { $nin: [null, ''] }
  if (q.hasEmail === 'false') filter.bestEmail = { $in: [null, ''] }

  const attempts: Record<string, number> = {}
  if (q.minAttempts) attempts.$gte = Number(q.minAttempts)
  if (q.maxAttempts) attempts.$lte = Number(q.maxAttempts)
  if (Object.keys(attempts).length) filter.attempts = attempts

  // Added-date window. `addedBefore` is what makes "clear out anything older than
  // six months" possible, which is the whole reason archiving exists.
  const created: Record<string, Date> = {}
  if (q.addedAfter && !Number.isNaN(Date.parse(q.addedAfter))) created.$gte = new Date(q.addedAfter)
  if (q.addedBefore && !Number.isNaN(Date.parse(q.addedBefore))) created.$lte = new Date(q.addedBefore)
  if (q.olderThanDays) {
    const days = Number(q.olderThanDays)
    if (Number.isFinite(days) && days > 0) {
      created.$lte = new Date(Date.now() - days * 86_400_000)
    }
  }
  if (Object.keys(created).length) filter.createdAt = created

  const called: Record<string, Date> = {}
  if (q.notCalledSinceDays) {
    const days = Number(q.notCalledSinceDays)
    if (Number.isFinite(days) && days > 0) called.$lte = new Date(Date.now() - days * 86_400_000)
  }
  if (Object.keys(called).length) filter.lastCalledAt = called

  if (q.search) {
    const digits = q.search.replace(/\D/g, '')
    const or: LeadQuery[] = [{ businessName: { $regex: escapeRegex(q.search), $options: 'i' } }]
    if (digits.length >= 3) or.push({ phone: { $regex: digits } })
    filter.$or = or
  }

  return filter
}

// A lead name can contain regex metacharacters; without escaping, a search for
// "A+B Auto" throws instead of returning nothing.
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Where a lead came from or went to is the owner's business: a caller must see a recycled
// lead as brand new, and must never learn another workspace exists.
function serialize(lead: InstanceType<typeof Lead>, req: Request) {
  const owner = req.org!.role === 'owner'
  return {
    ...(owner
      ? {
          recycledFrom: lead.recycledFrom ? { orgId: String(lead.recycledFrom.orgId), at: lead.recycledFrom.at } : null,
          recycle: lead.recycle ? { to: String(lead.recycle.to), state: lead.recycle.state, at: lead.recycle.at } : null,
        }
      : {}),
    id: String(lead._id),
    phone: lead.phone,
    phoneDisplay: formatForDisplay(lead.phone),
    businessName: lead.businessName,
    website: lead.website ?? null,
    bestEmail: lead.bestEmail ?? null,
    ownerName: lead.ownerName ?? null,
    ownerLabel: lead.ownerLabel ?? null,
    askForName: lead.askForName ?? null,
    askForRole: lead.askForRole ?? null,
    askForNote: lead.askForNote ?? null,
    address: lead.address ?? null,
    category: lead.category ?? null,
    rating: lead.rating ?? null,
    reviewCount: lead.reviewCount ?? null,
    siteQualityScore: lead.siteQualityScore ?? null,
    siteYear: lead.siteYear ?? null,
    sitePlatform: lead.sitePlatform ?? null,
    siteIssues: lead.siteIssues ?? [],
    hookSnippet: lead.hookSnippet ?? null,
    googleMapsUrl: lead.googleMapsUrl ?? null,
    lane: lead.lane ?? null,
    city: lead.city ?? null,
    state: lead.state ?? null,
    status: lead.status,
    doNotCall: lead.doNotCall,
    attempts: lead.attempts,
    lastCalledAt: lead.lastCalledAt ?? null,
    lastDisposition: lead.lastDisposition ?? null,
    lastDispositionLabel: lead.lastDispositionLabel ?? null,
    nextCallbackAt: lead.nextCallbackAt ?? null,
    notes: lead.notes ?? [],
    batch: lead.batch ?? null,
    archivedAt: lead.archivedAt ?? null,
    archivedReason: lead.archivedReason ?? null,
    createdAt: lead.createdAt ?? null,
    recordingAllowed: recordingAllowedFor(lead.state),
  }
}

// A lead with no state on the record is treated as not allowed: the failure mode of
// guessing wrong here is a felony in an all-party state, so unknown means no.
function recordingAllowedFor(state: string | null | undefined): boolean {
  if (!env.transcription.enabled) return false
  if (!state) return false
  return env.transcription.states.includes(state.trim().toUpperCase())
}

// GET /api/leads/queue?limit=50&batch=&lane=&search=
// Ordering: callbacks that are due, then never-attempted, then fewest attempts.
leadsRouter.get('/queue', async (req, res) => {
  const query = req.query as Record<string, string | undefined>
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
  const offset = Math.max(Number(req.query.offset) || 0, 0)

  const filter = buildLeadFilter(orgIdOf(req), query)

  // Callbacks scheduled for the future are held back until they are due — but only
  // in the callable view; an admin browsing all leads wants to see them.
  if ((query.view ?? 'queue') === 'queue') {
    const now = new Date()
    filter.$and = [
      { $or: [{ nextCallbackAt: { $exists: false } }, { nextCallbackAt: { $lte: now } }] },
    ]
  }

  // Count and page fetched together; at 30k+ leads the count is the slower half and
  // there is no reason to make the page wait for it.
  const [leads, total] = await Promise.all([
    Lead.find(filter)
      .sort({ nextCallbackAt: 1, attempts: 1, createdAt: 1, _id: 1 })
      .skip(offset)
      .limit(limit),
    Lead.countDocuments(filter),
  ])

  res.json({
    callWindow: checkCallWindow(),
    // Each person's own name and the workspace's own number, so two callers never read
    // each other's name and a lead is never told to ring back someone else's line.
    callerName: req.user!.displayName,
    callbackNumber: req.org!.callerId,
    companyName: req.org!.companyName,
    total,
    offset,
    limit,
    leads: leads.map((lead) => serialize(lead, req)),
  })
})

// GET /api/leads/facets — distinct values for the filter controls, so the UI offers
// only what actually exists in the data rather than a hardcoded list.
leadsRouter.get('/facets', async (req, res) => {
  const orgId = orgIdOf(req)
  const [cities, states, lanes, batches, issues, statuses, archivedCount, total] =
    await Promise.all([
      Lead.distinct('city', { orgId }),
      Lead.distinct('state', { orgId }),
      Lead.distinct('lane', { orgId }),
      Lead.distinct('batch', { orgId }),
      Lead.distinct('siteIssues', { orgId }),
      Lead.aggregate([{ $match: { orgId } }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Lead.countDocuments({ orgId, archivedAt: { $exists: true } }),
      Lead.countDocuments({ orgId }),
    ])

  const clean = (values: unknown[]) => values.filter((v): v is string => Boolean(v)).sort()

  res.json({
    cities: clean(cities),
    states: clean(states),
    lanes: clean(lanes),
    batches: clean(batches).reverse(),
    issues: clean(issues),
    statuses: statuses.map((s) => ({ status: s._id as string, count: s.count as number })),
    archivedCount,
    total,
  })
})

// POST /api/leads/:id/archive — any member: the Dial page archives a lead it can't use.
leadsRouter.post('/:id/archive', async (req, res) => {
  const { reason } = req.body as { reason?: string }
  const key = leadKey(req)
  const lead = key
    ? await Lead.findOneAndUpdate(
        { ...key, claimed: true },
        { $set: { archivedAt: new Date(), archivedReason: reason?.trim() || 'archived manually' } },
        { new: true },
      )
    : null
  if (!lead) {
    res.status(404).json({ error: 'lead not found' })
    return
  }
  res.json({ lead: serialize(lead, req) })
})

// POST /api/leads/:id/restore — owner. Only a lead this workspace still owns comes back.
leadsRouter.post('/:id/restore', requireOwner, async (req, res) => {
  const key = leadKey(req)
  const lead = key
    ? await Lead.findOneAndUpdate(
        { ...key, claimed: true },
        { $unset: { archivedAt: '', archivedReason: '' } },
        { new: true },
      )
    : null
  if (!lead) {
    res.status(404).json({ error: 'lead not found' })
    return
  }
  res.json({ lead: serialize(lead, req) })
})

// POST /api/leads/bulk-archive — admin. Archives everything matching the same filter
// vocabulary the browser uses, so what you see listed is exactly what gets archived.
// Requires an explicit confirm count to make a mis-scoped filter survivable.
leadsRouter.post('/bulk-archive', requireOwner, async (req, res) => {
  const query = (req.body?.filter ?? {}) as Record<string, string | undefined>
  const { expectedCount, reason } = req.body as { expectedCount?: number; reason?: string }

  const filter = buildLeadFilter(orgIdOf(req), { ...query, view: query.view ?? 'all' })
  filter.archivedAt = { $exists: false }

  const matched = await Lead.countDocuments(filter)

  if (typeof expectedCount !== 'number') {
    res.status(400).json({ error: 'expectedCount is required', matched })
    return
  }
  if (expectedCount !== matched) {
    res.status(409).json({
      error: `filter now matches ${matched} leads, not ${expectedCount}. Re-check and retry.`,
      matched,
    })
    return
  }
  if (matched === 0) {
    res.json({ archived: 0 })
    return
  }

  const result = await Lead.updateMany(filter, {
    $set: { archivedAt: new Date(), archivedReason: reason?.trim() || 'bulk archived' },
  })
  res.json({ archived: result.modifiedCount })
})

// DELETE /api/leads/:id — admin, permanent. Archiving is the reversible option and
// what the UI offers first; this exists for genuine mistakes (bad import, test rows).
// Call rows are removed too, otherwise the stats keep counting calls whose lead is
// gone and the recent-calls list renders blank names.
leadsRouter.delete('/:id', requireOwner, async (req, res) => {
  const key = leadKey(req)
  const lead = key ? await Lead.findOne(key, { _id: 1 }) : null
  if (!lead) {
    res.status(404).json({ error: 'lead not found' })
    return
  }
  const orgId = orgIdOf(req)
  const calls = await Call.deleteMany({ orgId, leadId: lead._id })
  await Lead.deleteOne({ _id: lead._id, orgId })
  res.json({ deleted: true, callsDeleted: calls.deletedCount })
})

async function ownsWorkspace(userId: string, orgId: string): Promise<boolean> {
  if (!isValidObjectId(orgId)) return false
  const [member, active] = await Promise.all([
    User.exists({ _id: userId, memberships: { $elemMatch: { orgId, role: 'owner' } } }),
    Organization.exists({ _id: orgId, status: 'active' }),
  ])
  return Boolean(member && active)
}

const RECYCLE_REFUSED: Record<Exclude<RecycleOutcome, 'recycled'>, string> = {
  not_eligible: `only a lost lead, rested ${env.recycle.restDays}+ days since its last call, not do-not-call or a wrong number, can move`,
  owned_elsewhere: 'another workspace already owns this number',
}

// POST /api/leads/:id/recycle { orgId } — owner of both workspaces. The lead starts over in
// the target as a new lead; its calls stay here.
leadsRouter.post('/:id/recycle', requireOwner, async (req, res) => {
  const { orgId: target } = req.body as { orgId?: string }
  if (!target || target === String(orgIdOf(req)) || !(await ownsWorkspace(req.user!.id, target))) {
    res.status(400).json({ error: 'pick another workspace you own' })
    return
  }
  if (!isValidObjectId(req.params.id)) {
    res.status(404).json({ error: 'lead not found' })
    return
  }
  const outcome = await recycleLead(orgIdOf(req), req.params.id!, new Types.ObjectId(target))
  if (outcome !== 'recycled') {
    res.status(409).json({ error: RECYCLE_REFUSED[outcome] })
    return
  }
  res.json({ recycled: 1 })
})

// POST /api/leads/bulk-recycle { filter, expectedCount, orgId } — owner. Moves every lead the
// recyclable view shows for this filter, guarded like bulk archive by the count on screen.
leadsRouter.post('/bulk-recycle', requireOwner, async (req, res) => {
  const { orgId: target, expectedCount } = req.body as { orgId?: string; expectedCount?: number }
  const query = (req.body?.filter ?? {}) as Record<string, string | undefined>
  if (!target || target === String(orgIdOf(req)) || !(await ownsWorkspace(req.user!.id, target))) {
    res.status(400).json({ error: 'pick another workspace you own' })
    return
  }

  await repairPendingRecycles()
  const filter = buildLeadFilter(orgIdOf(req), { ...query, view: 'recyclable' })
  const ids = await Lead.find(filter, { _id: 1 }).distinct('_id')
  if (typeof expectedCount !== 'number' || expectedCount !== ids.length) {
    res.status(409).json({ error: `the filter now matches ${ids.length} leads, not ${expectedCount}. Re-check and retry.`, matched: ids.length })
    return
  }

  const targetId = new Types.ObjectId(target)
  const tally: Record<RecycleOutcome, number> = { recycled: 0, not_eligible: 0, owned_elsewhere: 0 }
  for (const id of ids) tally[await recycleLead(orgIdOf(req), id, targetId)]++
  res.json({ recycled: tally.recycled, skipped: tally.not_eligible + tally.owned_elsewhere })
})

// GET /api/leads/batches
leadsRouter.get('/batches', async (req, res) => {
  const batches = await Lead.aggregate([
    { $match: { orgId: orgIdOf(req) } },
    { $group: { _id: '$batch', count: { $sum: 1 } } },
    { $sort: { _id: -1 } },
  ])
  res.json({
    batches: batches
      .filter((b) => b._id)
      .map((b) => ({ batch: b._id as string, count: b.count as number })),
  })
})

// GET /api/leads/:id
leadsRouter.get('/:id', async (req, res) => {
  const key = leadKey(req)
  const lead = key ? await Lead.findOne(key) : null
  if (!lead) {
    res.status(404).json({ error: 'lead not found' })
    return
  }
  const calls = await Call.find({ orgId: orgIdOf(req), leadId: lead._id }).sort({ startedAt: -1 }).limit(20)
  res.json({
    lead: serialize(lead, req),
    calls: calls.map((c) => ({
      id: String(c._id),
      attemptNumber: c.attemptNumber ?? null,
      startedAt: c.startedAt,
      answeredAt: c.answeredAt ?? null,
      duration: c.duration,
      dialStatus: c.dialStatus ?? null,
      disposition: c.disposition ?? null,
      dispositionLabel: c.dispositionLabel ?? null,
      username: c.username ?? null,
      direction: c.direction ?? 'outbound',
      handledBy: c.handledBy ?? null,
    })),
  })
})

// PATCH /api/leads/:id/disposition
leadsRouter.patch('/:id/disposition', async (req, res) => {
  const { disposition, dispositionLabel, note, callbackAt, callSid } = req.body as {
    disposition?: string
    dispositionLabel?: string
    note?: string
    callbackAt?: string
    callSid?: string
  }

  if (!disposition || !DISPOSITIONS.includes(disposition as Disposition)) {
    res.status(400).json({ error: `disposition must be one of: ${DISPOSITIONS.join(', ')}` })
    return
  }
  const typed = disposition as Disposition
  const label = typed === 'other' ? dispositionLabel?.trim().slice(0, 80) : undefined
  if (typed === 'other' && !label) {
    res.status(400).json({ error: 'an "other" outcome needs a label' })
    return
  }

  const key = leadKey(req)
  const lead = key ? await Lead.findOne({ ...key, claimed: true }) : null
  if (!lead) {
    res.status(404).json({ error: 'lead not found' })
    return
  }

  lead.set({
    lastDisposition: typed,
    lastDispositionLabel: label,
    status: DISPOSITION_TO_STATUS[typed],
    lastCalledAt: new Date(),
  })

  if (typed === 'do_not_call') lead.set({ doNotCall: true })

  if (callbackAt) {
    const when = new Date(callbackAt)
    if (Number.isNaN(when.getTime())) {
      res.status(400).json({ error: 'callbackAt is not a valid date' })
      return
    }
    lead.set({ nextCallbackAt: when })
  } else if (isRetryable(typed)) {
    // Without this the lead drops straight back into the queue and can be redialed
    // the same evening — which reads as harassment and burns the number.
    const plan = planRetry(lead.attempts)
    if (plan.exhausted) {
      lead.set({ status: 'lost', nextCallbackAt: undefined })
      lead.notes.push({
        body: `Auto-closed after ${lead.attempts} attempts without a result.`,
        author: 'system',
        at: new Date(),
      })
    } else {
      lead.set({ nextCallbackAt: plan.at })
    }
  } else if (typed !== 'callback_later' && typed !== 'interested') {
    lead.set({ nextCallbackAt: undefined })
  }

  if (note?.trim()) {
    lead.notes.push({ body: note.trim(), author: req.user?.username ?? 'unknown', at: new Date() })
  }

  await lead.save()
  if (typed === 'do_not_call') {
    await suppress(lead.phone, { reason: 'asked on a call', source: 'disposition', orgId: orgIdOf(req), by: req.user!.username })
  }

  // The browser knows the parent CallSid from the SDK; the Call row was created
  // server-side by the voice webhook, so resolve it by SID rather than trusting an id.
  // Scoped to this lead too, so an outcome can only ever land on one of its own calls.
  if (callSid) {
    await Call.findOneAndUpdate(
      { orgId: orgIdOf(req), leadId: lead._id, parentCallSid: callSid },
      label ? { disposition: typed, dispositionLabel: label } : { disposition: typed, $unset: { dispositionLabel: 1 } },
    )
  }

  res.json({ lead: serialize(lead, req) })
})

// PATCH /api/leads/:id — manual edits (status override, DNC flag, notes)
leadsRouter.patch('/:id', async (req, res) => {
  const { status, doNotCall, note } = req.body as {
    status?: string
    doNotCall?: boolean
    note?: string
  }

  // Lifting a do-not-call is the owner's decision: it reopens the number for every workspace.
  if (doNotCall === false && req.org!.role !== 'owner') {
    res.status(403).json({ error: 'only the owner can lift a do-not-call' })
    return
  }

  const key = leadKey(req)
  const lead = key ? await Lead.findOne({ ...key, claimed: true }) : null
  if (!lead) {
    res.status(404).json({ error: 'lead not found' })
    return
  }

  if (status) {
    if (!LEAD_STATUSES.includes(status as never)) {
      res.status(400).json({ error: `status must be one of: ${LEAD_STATUSES.join(', ')}` })
      return
    }
    lead.set({ status })
  }
  if (typeof doNotCall === 'boolean') {
    lead.set({ doNotCall, ...(doNotCall ? { status: 'dnc' } : {}) })
  }
  if (note?.trim()) {
    lead.notes.push({ body: note.trim(), author: req.user?.username ?? 'unknown', at: new Date() })
  }

  await lead.save()
  if (doNotCall === true) {
    await suppress(lead.phone, { reason: 'marked do not call', source: 'manual', orgId: orgIdOf(req), by: req.user!.username })
  } else if (doNotCall === false) {
    await liftSuppression(lead.phone)
  }
  res.json({ lead: serialize(lead, req) })
})
