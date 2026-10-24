import { isValidObjectId, type PipelineStage, type Types } from 'mongoose'
import { Call } from '../models/Call.js'
import { DISPOSITIONS, Lead, type Disposition } from '../models/Lead.js'
import { formatForDisplay } from '../lib/phone.js'
import { escapeRegex } from '../lib/regex.js'
import { safeRouter } from '../lib/safeRouter.js'

export const transcriptsRouter = safeRouter()

const SORT_FIELDS = {
  startedAt: 'startedAt',
  business: 'sortName',
  caller: 'username',
  attempt: 'attemptNumber',
  duration: 'duration',
  outcome: 'disposition',
} as const
type SortKey = keyof typeof SORT_FIELDS

const PAGE_SIZES = [10, 25, 50]
// "Real conversations": anything shorter is a hang-up or a greeting, not a pitch worth reading.
const REAL_MIN_SECONDS = 30

type Line = { speaker: 'caller' | 'lead' | 'ai'; start: number; text: string }

type Row = {
  _id: unknown
  startedAt: Date
  duration?: number
  direction?: string
  handledBy?: string
  username?: string
  attemptNumber?: number
  disposition?: string
  dispositionLabel?: string
  fromNumber?: string
  lead?: { businessName?: string; phone?: string }
  transcriptError?: { stage: string; message?: string }
  aiSummary?: { business?: string; name?: string }
  transcript?: { text?: string; lines?: Line[] }
}

// The line that best represents the call in one row: the search hit, else the first thing the lead said.
function snippetOf(lines: Line[] | undefined, text: string | undefined, term: string): { speaker: Line['speaker'] | null; text: string } | null {
  const needle = term.toLowerCase()
  const pick =
    (needle && lines?.find((l) => l.text.toLowerCase().includes(needle))) ||
    lines?.find((l) => l.speaker === 'lead' && l.text.trim().length > 3) ||
    lines?.[0]
  if (pick) return { speaker: pick.speaker, text: around(pick.text, needle) }
  return text ? { speaker: null, text: around(text, needle) } : null
}

function around(text: string, needle: string): string {
  const at = needle ? text.toLowerCase().indexOf(needle) : -1
  if (at < 60) return text.slice(0, 160)
  return `…${text.slice(at - 50, at + 110)}`
}

const displayPhone = (e164: string | null | undefined) => (e164 ? formatForDisplay(e164) : null)

async function buildMatch(orgId: Types.ObjectId, q: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const match: Record<string, unknown> =
    q.status === 'failed'
      ? { orgId, 'transcript.text': { $exists: false }, transcriptError: { $exists: true } }
      : { orgId, 'transcript.text': { $exists: true } }

  if (q.direction === 'inbound') match.direction = 'inbound'
  if (q.direction === 'outbound') match.direction = { $ne: 'inbound' }
  if (q.caller) match.username = q.caller
  if (q.outcome === 'none') match.disposition = null
  else if (q.outcome && DISPOSITIONS.includes(q.outcome as Disposition)) match.disposition = q.outcome

  const minSeconds = Number(q.minSeconds)
  if (Number.isFinite(minSeconds) && minSeconds > 0) match.duration = { $gte: minSeconds }
  const days = Number(q.days)
  if (Number.isFinite(days) && days > 0) match.startedAt = { $gte: new Date(Date.now() - days * 86_400_000) }
  // $and so it narrows the outcome and length filters instead of overwriting them.
  if (q.real === '1') match.$and = [{ disposition: { $ne: 'voicemail' } }, { duration: { $gte: REAL_MIN_SECONDS } }]

  const term = q.search?.trim().slice(0, 100)
  if (term) {
    const rx = { $regex: escapeRegex(term), $options: 'i' }
    const digits = term.replace(/\D/g, '')
    const leadIds = await Lead.find({
      orgId,
      $or: [{ businessName: rx }, ...(digits.length >= 3 ? [{ phone: { $regex: digits } }] : [])],
    }).distinct('_id')
    match.$or = [
      { 'transcript.text': rx },
      { leadId: { $in: leadIds } },
      { 'aiSummary.business': rx },
      { 'aiSummary.name': rx },
      ...(digits.length >= 3 ? [{ fromNumber: { $regex: digits } }] : []),
    ]
  }
  return match
}

const ROW_FIELDS = {
  startedAt: 1,
  duration: 1,
  direction: 1,
  handledBy: 1,
  username: 1,
  attemptNumber: 1,
  disposition: 1,
  dispositionLabel: 1,
  fromNumber: 1,
  lead: 1,
  transcriptError: 1,
  'aiSummary.business': 1,
  'aiSummary.name': 1,
  'transcript.text': 1,
  'transcript.lines': 1,
}

// The tenant guard can't see inside a $lookup, so the joined side matches orgId itself.
const leadLookup = (orgId: Types.ObjectId): PipelineStage.FacetPipelineStage[] => [
  {
    $lookup: {
      from: 'leads',
      localField: 'leadId',
      foreignField: '_id',
      as: 'lead',
      pipeline: [{ $match: { orgId } }, { $project: { businessName: 1, phone: 1 } }],
    },
  },
  { $addFields: { lead: { $first: '$lead' } } },
]

// GET /api/transcripts?search=&outcome=&caller=&direction=&minSeconds=&days=&status=&sort=&dir=&limit=&offset=
transcriptsRouter.get('/', async (req, res) => {
  const q = req.query as Record<string, string | undefined>
  const limit = PAGE_SIZES.includes(Number(q.limit)) ? Number(q.limit) : 10
  const offset = Math.max(Math.floor(Number(q.offset) || 0), 0)
  const sortKey: SortKey = q.sort && q.sort in SORT_FIELDS ? (q.sort as SortKey) : 'startedAt'
  const dir = q.dir === 'asc' ? 1 : -1
  const term = q.search?.trim().slice(0, 100) ?? ''

  const orgId = req.org!.id
  const match = await buildMatch(orgId, q)
  // Sorting by name needs the lead joined first; every other sort joins only the page's rows.
  const byName = sortKey === 'business'
  const nameKey: PipelineStage[] = [
    {
      $addFields: {
        sortName: { $toLower: { $ifNull: ['$lead.businessName', { $ifNull: ['$aiSummary.business', ''] }] } },
      },
    },
  ]

  const pipeline: PipelineStage[] = [
    { $match: match },
    ...(byName ? [...leadLookup(orgId), ...nameKey] : []),
    {
      $facet: {
        total: [{ $count: 'n' }],
        rows: [
          { $sort: { [SORT_FIELDS[sortKey]]: dir, _id: dir } },
          { $skip: offset },
          { $limit: limit },
          ...(byName ? [] : leadLookup(orgId)),
          { $project: ROW_FIELDS },
        ],
      },
    },
  ]
  const [[result], callers] = await Promise.all([
    Call.aggregate(pipeline),
    Call.distinct('username', { orgId, direction: { $ne: 'inbound' } }),
  ])
  const rows = (result?.rows ?? []) as Row[]

  res.json({
    total: (result?.total?.[0]?.n as number | undefined) ?? 0,
    offset,
    limit,
    callers: callers.filter(Boolean).sort(),
    rows: rows.map((c) => ({
      id: String(c._id),
      startedAt: c.startedAt,
      duration: c.duration ?? 0,
      direction: c.direction ?? 'outbound',
      handledBy: c.handledBy ?? null,
      username: c.username ?? null,
      attemptNumber: c.attemptNumber ?? null,
      disposition: c.disposition ?? null,
      dispositionLabel: c.dispositionLabel ?? null,
      businessName: c.lead?.businessName ?? c.aiSummary?.business ?? null,
      phone: displayPhone(c.lead?.phone ?? c.fromNumber),
      lineCount: c.transcript?.lines?.length ?? 0,
      snippet: snippetOf(c.transcript?.lines, c.transcript?.text, term),
      error: c.transcriptError ? { stage: c.transcriptError.stage, message: c.transcriptError.message ?? null } : null,
    })),
  })
})

// GET /api/transcripts/:id — the full conversation, fetched only when a row is opened.
transcriptsRouter.get('/:id', async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    res.status(404).json({ error: 'call not found' })
    return
  }
  const orgId = req.org!.id
  const call = await Call.findOne({ _id: req.params.id, orgId }).populate({
    path: 'leadId',
    select: 'businessName phone city state',
    match: { orgId },
  })
  if (!call) {
    res.status(404).json({ error: 'call not found' })
    return
  }
  const lead = call.leadId as unknown as { _id: unknown; businessName?: string; phone?: string; city?: string; state?: string } | null
  const quality = call.quality
  res.json({
    id: String(call._id),
    leadId: lead ? String(lead._id) : null,
    businessName: lead?.businessName ?? call.aiSummary?.business ?? null,
    phone: displayPhone(lead?.phone ?? call.fromNumber),
    place: [lead?.city, lead?.state].filter(Boolean).join(', ') || null,
    startedAt: call.startedAt,
    answeredAt: call.answeredAt ?? null,
    duration: call.duration ?? 0,
    direction: call.direction ?? 'outbound',
    handledBy: call.handledBy ?? null,
    username: call.username ?? null,
    attemptNumber: call.attemptNumber ?? null,
    disposition: call.disposition ?? null,
    dispositionLabel: call.dispositionLabel ?? null,
    aiSummary: call.aiSummary ?? null,
    transcript: call.transcript?.text
      ? {
          text: call.transcript.text,
          lines: call.transcript.lines ?? [],
          model: call.transcript.model ?? null,
          processingSeconds: call.transcript.processingSeconds ?? null,
        }
      : null,
    error: call.transcriptError
      ? { stage: call.transcriptError.stage, message: call.transcriptError.message ?? null }
      : null,
    quality: quality
      ? {
          avgMos: quality.avgMos ?? null,
          outLossPct: quality.outLossPct ?? null,
          maxOutLossPct: quality.maxOutLossPct ?? null,
          voiceDb: quality.voiceDb ?? null,
          voiceFloorDb: quality.voiceFloorDb ?? null,
          voicePeakDb: quality.voicePeakDb ?? null,
          codec: quality.codec ?? null,
          mic: quality.mic?.label ?? null,
        }
      : null,
  })
})
