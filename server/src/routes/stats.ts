import type { PipelineStage, Types } from 'mongoose'
import { Call, INBOUND_HANDLERS } from '../models/Call.js'
import { Lead, type Disposition } from '../models/Lead.js'
import { requireOwner } from '../auth.js'
import { env } from '../config/env.js'
import { formatForDisplay } from '../lib/phone.js'
import { escapeRegex } from '../lib/regex.js'
import { safeRouter } from '../lib/safeRouter.js'

export const statsRouter = safeRouter()

// Twilio marks a call "completed" whenever anything picks up — voicemail included — so
// only the caller's own disposition says whether a person was on the line. Record<> makes
// the build fail if a new disposition is added without deciding which bucket it counts in.
// A custom "other" label says nothing about who answered, so Twilio's status decides it.
const OUTCOME_OF: Record<Disposition, 'talked' | 'voicemail' | 'not_reached' | 'by_dial_status'> = {
  connected: 'talked',
  interested: 'talked',
  callback_later: 'talked',
  booked: 'talked',
  not_interested: 'talked',
  do_not_call: 'talked',
  hung_up: 'talked',
  voicemail: 'voicemail',
  no_answer: 'not_reached',
  busy: 'not_reached',
  wrong_number: 'not_reached',
  other: 'by_dial_status',
}
const dispositionsIn = (bucket: string) =>
  Object.entries(OUTCOME_OF)
    .filter(([, b]) => b === bucket)
    .map(([d]) => d)

// Picked up but no disposition saved: counted on its own rather than guessed.
const WITH_OUTCOME = {
  $addFields: {
    outcome: {
      $switch: {
        branches: [
          { case: { $in: ['$disposition', dispositionsIn('talked')] }, then: 'talked' },
          { case: { $in: ['$disposition', dispositionsIn('voicemail')] }, then: 'voicemail' },
          { case: { $in: ['$disposition', dispositionsIn('not_reached')] }, then: 'not_reached' },
          {
            case: {
              $and: [{ $in: ['$disposition', dispositionsIn('by_dial_status')] }, { $eq: ['$dialStatus', 'completed'] }],
            },
            then: 'talked',
          },
          { case: { $in: ['$disposition', dispositionsIn('by_dial_status')] }, then: 'not_reached' },
          { case: { $eq: ['$dialStatus', 'completed'] }, then: 'unlabeled' },
        ],
        default: 'not_reached',
      },
    },
  },
}
const countOf = (outcome: string) => ({ $sum: { $cond: [{ $eq: ['$outcome', outcome] }, 1, 0] } })
const talkedSeconds = { $sum: { $cond: [{ $eq: ['$outcome', 'talked'] }, '$duration', 0] } }

// Inbound calls (callbacks to our number) have no attempt, caller or disposition, so every
// dialing metric below excludes them; they are counted separately in `inbound`.
const OUTBOUND = { direction: { $ne: 'inbound' } }

// GET /api/stats/overview?days=14 — every member, read-only: a caller sees their own workspace.
statsRouter.get('/overview', async (req, res) => {
  const orgId = req.org!.id
  const days = Math.min(Number(req.query.days) || 14, 90)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const [byDay, byHour, byAttempt, byDisposition, byStatus, byCaller, totals, inboundByHandler] = await Promise.all([
    Call.aggregate([
      { $match: { orgId, startedAt: { $gte: since }, ...OUTBOUND } },
      WITH_OUTCOME,
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt' } },
          calls: { $sum: 1 },
          talked: countOf('talked'),
          voicemail: countOf('voicemail'),
          talkSeconds: talkedSeconds,
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // Connect rate by hour of the LEADS' day — tells you which hours of the shift
    // are worth staffing and which are wasted minutes.
    Call.aggregate([
      { $match: { orgId, startedAt: { $gte: since }, ...OUTBOUND } },
      WITH_OUTCOME,
      {
        $group: {
          _id: {
            $dateToString: { format: '%H', date: '$startedAt', timezone: env.callWindow.timeZone },
          },
          calls: { $sum: 1 },
          talked: countOf('talked'),
          voicemail: countOf('voicemail'),
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // Does attempt 4 still connect? This is what justifies (or kills) the cadence.
    Call.aggregate([
      { $match: { orgId, startedAt: { $gte: since }, ...OUTBOUND, attemptNumber: { $ne: null } } },
      WITH_OUTCOME,
      {
        $group: {
          _id: '$attemptNumber',
          calls: { $sum: 1 },
          talked: countOf('talked'),
          voicemail: countOf('voicemail'),
        },
      },
      { $sort: { _id: 1 } },
    ]),

    Call.aggregate([
      { $match: { orgId, startedAt: { $gte: since }, ...OUTBOUND, disposition: { $ne: null } } },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ['$disposition', 'other'] },
              { $concat: ['other: ', { $toLower: { $ifNull: ['$dispositionLabel', ''] } }] },
              '$disposition',
            ],
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]),

    // The pipeline is what this workspace owns now; a lead recycled away stays in its call history only.
    Lead.aggregate([
      { $match: { orgId, claimed: true } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    Call.aggregate([
      { $match: { orgId, startedAt: { $gte: since }, ...OUTBOUND } },
      WITH_OUTCOME,
      {
        $group: {
          _id: '$username',
          calls: { $sum: 1 },
          talked: countOf('talked'),
          talkSeconds: talkedSeconds,
        },
      },
      { $sort: { calls: -1 } },
    ]),

    Call.aggregate([
      { $match: { orgId, startedAt: { $gte: since }, ...OUTBOUND } },
      WITH_OUTCOME,
      {
        $group: {
          _id: null,
          calls: { $sum: 1 },
          talked: countOf('talked'),
          voicemail: countOf('voicemail'),
          notReached: countOf('not_reached'),
          unlabeled: countOf('unlabeled'),
          talkSeconds: talkedSeconds,
          billedSeconds: { $sum: '$duration' },
        },
      },
    ]),

    Call.aggregate([
      { $match: { orgId, startedAt: { $gte: since }, direction: 'inbound' } },
      { $group: { _id: '$handledBy', calls: { $sum: 1 }, seconds: { $sum: '$duration' } } },
    ]),
  ])

  const inboundCount = (h: string) => (inboundByHandler.find((d) => d._id === h)?.calls as number) ?? 0

  const totalLeads = await Lead.countDocuments({ orgId, claimed: true })
  const summary = totals[0] ?? {
    calls: 0,
    talked: 0,
    voicemail: 0,
    notReached: 0,
    unlabeled: 0,
    talkSeconds: 0,
    billedSeconds: 0,
  }

  res.json({
    days,
    totalLeads,
    summary: {
      calls: summary.calls,
      talked: summary.talked,
      voicemail: summary.voicemail,
      notReached: summary.notReached,
      unlabeled: summary.unlabeled,
      talkRate: summary.calls ? summary.talked / summary.calls : 0,
      talkSeconds: summary.talkSeconds,
      // Rounded-up minutes is how Twilio actually bills (voicemails included), so this matches the invoice.
      estimatedCostUsd: Number((estimateBillableMinutes(summary.billedSeconds, summary.calls) * 0.018).toFixed(2)),
    },
    byDay: byDay.map((d) => ({
      date: d._id as string,
      calls: d.calls as number,
      talked: d.talked as number,
      voicemail: d.voicemail as number,
      talkSeconds: d.talkSeconds as number,
    })),
    byHour: byHour.map((d) => ({
      hour: Number(d._id),
      calls: d.calls as number,
      talked: d.talked as number,
      voicemail: d.voicemail as number,
    })),
    byAttempt: byAttempt.map((d) => ({
      attempt: d._id as number,
      calls: d.calls as number,
      talked: d.talked as number,
      voicemail: d.voicemail as number,
    })),
    inbound: {
      total: inboundByHandler.reduce((n, d) => n + (d.calls as number), 0),
      ai: inboundCount('ai'),
      human: inboundCount('human'),
      missed: inboundCount('missed'),
      aiSeconds: (inboundByHandler.find((d) => d._id === 'ai')?.seconds as number) ?? 0,
    },
    byDisposition: byDisposition.map((d) => ({ disposition: d._id as string, count: d.count as number })),
    byStatus: byStatus.map((d) => ({ status: d._id as string, count: d.count as number })),
    byCaller: byCaller.map((d) => ({
      username: d._id as string,
      calls: d.calls as number,
      talked: d.talked as number,
      talkSeconds: d.talkSeconds as number,
    })),
  })
})

// Twilio bills each call rounded up to the next whole minute, so a pile of short
// calls costs far more than total-seconds/60 suggests.
function estimateBillableMinutes(totalSeconds: number, callCount: number): number {
  if (callCount === 0) return 0
  const avgSeconds = totalSeconds / callCount
  return Math.ceil(avgSeconds / 60) * callCount
}

// GET /api/stats/recent-calls?limit=50&withTranscript=1
// Bulk export for offline review (e.g. comparing openers); the Transcripts page uses /api/transcripts instead.
statsRouter.get('/recent-calls', requireOwner, async (req, res) => {
  const orgId = req.org!.id
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const filter = req.query.withTranscript ? { orgId, 'transcript.text': { $exists: true } } : { orgId }

  const calls = await Call.find(filter)
    .sort({ startedAt: -1 })
    .limit(limit)
    .populate({ path: 'leadId', select: 'businessName phone', match: { orgId } })

  res.json({
    calls: calls.map((c) => {
      const lead = c.leadId as unknown as { businessName?: string; phone?: string } | null
      return {
        id: String(c._id),
        businessName: lead?.businessName ?? null,
        phone: lead?.phone ?? c.fromNumber ?? null,
        username: c.username ?? null,
        direction: c.direction ?? 'outbound',
        handledBy: c.handledBy ?? null,
        fromNumber: c.fromNumber ?? null,
        aiSummary: c.aiSummary ?? null,
        attemptNumber: c.attemptNumber ?? null,
        startedAt: c.startedAt,
        answeredAt: c.answeredAt ?? null,
        duration: c.duration ?? 0,
        dialStatus: c.dialStatus ?? null,
        disposition: c.disposition ?? null,
        dispositionLabel: c.dispositionLabel ?? null,
        transcript: c.transcript?.text
          ? {
              text: c.transcript.text,
              lines: c.transcript.lines ?? [],
              model: c.transcript.model ?? null,
            }
          : null,
      }
    }),
  })
})

// Area code 555 doesn't exist and 555-01XX is reserved for fiction: only our simulated calls use them.
const TEST_NUMBER = /^\+1(555\d{7}|\d{3}55501\d{2})$/

const CALLBACK_SORTS = {
  startedAt: 'startedAt',
  business: 'sortName',
  handledBy: 'handledBy',
  duration: 'duration',
  status: 'lead.status',
} as const
type CallbackSort = keyof typeof CALLBACK_SORTS

const CALLBACK_PAGE_SIZES = [10, 25, 50]

type CallbackDoc = {
  _id: unknown
  startedAt: Date
  duration?: number
  handledBy?: string
  inboundReason?: string
  fromNumber?: string
  aiSummary?: Record<string, unknown> & { flags?: string[] }
  transcript?: { text?: string; lines?: { speaker: string; text: string }[] }
  lead?: {
    _id: unknown
    businessName?: string
    ownerName?: string
    city?: string
    state?: string
    status?: string
    doNotCall?: boolean
  }
  prior?: { startedAt: Date; disposition?: string; dispositionLabel?: string; username?: string }[]
}

// The tenant guard can't see inside a $lookup, so the joined side matches orgId itself.
const callbackLeadLookup = (orgId: Types.ObjectId): PipelineStage.FacetPipelineStage[] => [
  {
    $lookup: {
      from: 'leads',
      localField: 'leadId',
      foreignField: '_id',
      as: 'lead',
      pipeline: [
        { $match: { orgId } },
        { $project: { businessName: 1, ownerName: 1, city: 1, state: 1, status: 1, doNotCall: 1 } },
      ],
    },
  },
  { $addFields: { lead: { $first: '$lead' } } },
]

// GET /api/stats/callbacks?search=&handledBy=&who=lead|unknown|test&days=&sort=&dir=&limit=&offset=
statsRouter.get('/callbacks', async (req, res) => {
  const orgId = req.org!.id
  const q = req.query as Record<string, string | undefined>
  const limit = CALLBACK_PAGE_SIZES.includes(Number(q.limit)) ? Number(q.limit) : 10
  const offset = Math.max(Math.floor(Number(q.offset) || 0), 0)
  const sortKey: CallbackSort = q.sort && q.sort in CALLBACK_SORTS ? (q.sort as CallbackSort) : 'startedAt'
  const dir = q.dir === 'asc' ? 1 : -1

  const match: Record<string, unknown> = { orgId, direction: 'inbound' }
  if (INBOUND_HANDLERS.includes(q.handledBy as (typeof INBOUND_HANDLERS)[number])) match.handledBy = q.handledBy
  if (q.who === 'lead') match.leadId = { $ne: null }
  if (q.who === 'unknown') Object.assign(match, { leadId: null, fromNumber: { $not: TEST_NUMBER } })
  if (q.who === 'test') match.fromNumber = TEST_NUMBER
  const days = Number(q.days)
  if (Number.isFinite(days) && days > 0) match.startedAt = { $gte: new Date(Date.now() - days * 86_400_000) }

  const term = q.search?.trim().slice(0, 100)
  if (term) {
    const rx = { $regex: escapeRegex(term), $options: 'i' }
    const digits = term.replace(/\D/g, '')
    const leadIds = await Lead.find({
      orgId,
      $or: [{ businessName: rx }, { ownerName: rx }, { city: rx }, ...(digits.length >= 3 ? [{ phone: { $regex: digits } }] : [])],
    }).distinct('_id')
    match.$or = [
      { leadId: { $in: leadIds } },
      ...['name', 'business', 'reason', 'notes', 'email', 'bestTime'].map((k) => ({ [`aiSummary.${k}`]: rx })),
      { 'transcript.text': rx },
      ...(digits.length >= 3 ? [{ fromNumber: { $regex: digits } }, { 'aiSummary.callbackNumber': { $regex: digits } }] : []),
    ]
  }

  // Sorting by a lead field needs the lead joined first; otherwise only the page's rows are joined.
  const joinFirst = sortKey === 'business' || sortKey === 'status'
  const pipeline: PipelineStage[] = [
    { $match: match },
    ...(joinFirst
      ? [
          ...callbackLeadLookup(orgId),
          {
            $addFields: {
              sortName: { $toLower: { $ifNull: ['$lead.businessName', { $ifNull: ['$aiSummary.business', ''] }] } },
            },
          },
        ]
      : []),
    {
      $facet: {
        total: [{ $count: 'n' }],
        rows: [
          { $sort: { [CALLBACK_SORTS[sortKey]]: dir, _id: dir } },
          { $skip: offset },
          { $limit: limit },
          ...(joinFirst ? [] : callbackLeadLookup(orgId)),
          {
            $lookup: {
              from: 'calls',
              let: { leadId: '$leadId', at: '$startedAt' },
              as: 'prior',
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$orgId', orgId] },
                        { $eq: ['$leadId', '$$leadId'] },
                        { $ne: ['$direction', 'inbound'] },
                        { $lt: ['$startedAt', '$$at'] },
                      ],
                    },
                  },
                },
                { $sort: { startedAt: -1 } },
                { $project: { startedAt: 1, disposition: 1, dispositionLabel: 1, username: 1 } },
              ],
            },
          },
          {
            $project: {
              startedAt: 1,
              duration: 1,
              handledBy: 1,
              inboundReason: 1,
              fromNumber: 1,
              aiSummary: 1,
              lead: 1,
              prior: 1,
              'transcript.text': 1,
              'transcript.lines': 1,
            },
          },
        ],
      },
    },
  ]

  const [result] = await Call.aggregate(pipeline)
  const rows = (result?.rows ?? []) as CallbackDoc[]

  const numbers = [...new Set(rows.map((r) => r.fromNumber).filter(Boolean))]
  const repeats = numbers.length
    ? await Call.aggregate([
        { $match: { orgId, direction: 'inbound', fromNumber: { $in: numbers } } },
        { $group: { _id: '$fromNumber', n: { $sum: 1 } } },
      ])
    : []
  const timesCalled = new Map(repeats.map((r) => [r._id as string, r.n as number]))

  res.json({
    total: (result?.total?.[0]?.n as number | undefined) ?? 0,
    offset,
    limit,
    leadTimeZone: env.callWindow.timeZone,
    rows: rows.map((c) => {
      const last = c.prior?.[0]
      const said = c.transcript?.lines?.find((l) => l.speaker === 'lead' && l.text.trim().length > 3)?.text
      return {
        id: String(c._id),
        startedAt: c.startedAt,
        duration: c.duration ?? 0,
        handledBy: c.handledBy ?? 'missed',
        reason: c.inboundReason ?? null,
        phone: c.fromNumber ? formatForDisplay(c.fromNumber) : null,
        isTest: TEST_NUMBER.test(c.fromNumber ?? ''),
        timesCalled: (c.fromNumber && timesCalled.get(c.fromNumber)) || 1,
        lead: c.lead
          ? {
              id: String(c.lead._id),
              businessName: c.lead.businessName ?? null,
              ownerName: c.lead.ownerName ?? null,
              place: [c.lead.city, c.lead.state].filter(Boolean).join(', ') || null,
              status: c.lead.status ?? null,
              doNotCall: Boolean(c.lead.doNotCall),
            }
          : null,
        aiSummary: c.aiSummary ?? null,
        ourCalls: c.prior?.length ?? 0,
        lastOutbound: last
          ? {
              startedAt: last.startedAt,
              disposition: last.disposition ?? null,
              dispositionLabel: last.dispositionLabel ?? null,
              username: last.username ?? null,
            }
          : null,
        snippet: said ? said.slice(0, 160) : (c.transcript?.text?.slice(0, 160) ?? null),
        hasTranscript: Boolean(c.transcript?.text),
      }
    }),
  })
})
