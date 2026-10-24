import { Schema, model, type InferSchemaType } from 'mongoose'
import { tenantScope } from '../lib/tenantScope.js'

export const LEAD_STATUSES = [
  'new',
  'contacted',
  'callback',
  'booked',
  'won',
  'lost',
  'dnc',
] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]

// Outcomes the caller picks after hanging up. Distinct from `status`, which is the
// lead's position in the pipeline — one call produces one disposition, and the
// disposition drives the status transition.
export const DISPOSITIONS = [
  'connected',
  'voicemail',
  'no_answer',
  'busy',
  'wrong_number',
  'not_interested',
  'callback_later',
  'interested',
  'booked',
  'do_not_call',
  'hung_up',
  'other',
] as const
export type Disposition = (typeof DISPOSITIONS)[number]

export const RECYCLE_STATES = ['pending', 'done'] as const

const noteSchema = new Schema(
  {
    body: { type: String, required: true, trim: true },
    author: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
)

const leadSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, immutable: true },
    phone: { type: String, required: true },
    // One lead document is one workspace's tenure on a phone. `claimed` marks the single
    // document, across every workspace, that owns the phone right now; only it is dialable.
    claimed: Boolean,
    businessName: { type: String, required: true, trim: true },
    website: String,
    bestEmail: String,
    ownerName: String,
    // Where ownerName came from ("state filing", "registered agent, unconfirmed", "their email, unsure").
    ownerLabel: String,
    // Who customers name in their reviews ("Thank you Tommy"), from the lead source.
    askForName: String,
    askForRole: String,
    askForNote: String,
    address: String,
    category: String,
    rating: Number,
    reviewCount: Number,
    siteQualityScore: Number,
    siteYear: Number,
    sitePlatform: String,
    siteIssues: { type: [String], default: [] },
    hookSnippet: String,
    googleMapsUrl: String,
    lane: String,
    city: String,
    state: String,

    status: { type: String, enum: LEAD_STATUSES, default: 'new' },
    // A copy of the brand-wide `suppressions` list, kept so filters and the card can show it.
    doNotCall: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
    lastCalledAt: Date,
    lastDisposition: { type: String, enum: DISPOSITIONS },
    // The caller's own words when the outcome is `other`.
    lastDispositionLabel: String,
    nextCallbackAt: Date,
    notes: { type: [noteSchema], default: [] },
    batch: String,

    // Archiving is reversible and keeps call history intact, which is why it is the
    // default way to get a lead out of the way. Deleting is a separate admin action.
    archivedAt: Date,
    archivedReason: String,

    // Owner-only bookkeeping for a lead moved between workspaces; never sent to a caller.
    // `recycle` is on the old tenure (pending until the copy exists, then done); `recycledFrom`
    // is on the new one.
    recycle: {
      type: new Schema(
        {
          to: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
          state: { type: String, enum: RECYCLE_STATES, required: true },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    recycledFrom: {
      type: new Schema(
        {
          orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
          leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
)

leadSchema.plugin(tenantScope)

// A company belongs to one workspace at a time. Enforced here rather than in the importer so
// no code path (import, recycle, a script) can hand the same business to two callers.
leadSchema.index(
  { phone: 1 },
  { name: 'phone_claimed_unique', unique: true, partialFilterExpression: { claimed: { $eq: true } } },
)
leadSchema.index({ orgId: 1, phone: 1 })

// Matches the queue's actual sort key so paging stays index-backed at 30k+ leads
// instead of degrading into an in-memory sort of the whole matching set.
leadSchema.index({ orgId: 1, nextCallbackAt: 1, attempts: 1, createdAt: 1, _id: 1 })

// The admin browser's common narrowings.
leadSchema.index({ orgId: 1, archivedAt: 1, status: 1, createdAt: -1 })
leadSchema.index({ orgId: 1, city: 1, status: 1 })
leadSchema.index({ orgId: 1, siteIssues: 1 })
leadSchema.index({ orgId: 1, batch: 1 })

// One copy per recycled tenure, so finishing an interrupted recycle twice can't duplicate it.
leadSchema.index(
  { 'recycledFrom.leadId': 1 },
  { unique: true, partialFilterExpression: { 'recycledFrom.leadId': { $exists: true } } },
)
leadSchema.index({ 'recycle.state': 1 }, { partialFilterExpression: { 'recycle.state': { $exists: true } } })

export type LeadDoc = InferSchemaType<typeof leadSchema>
export const Lead = model('Lead', leadSchema)
