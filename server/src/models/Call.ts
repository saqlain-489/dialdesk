import { Schema, model, Types, type InferSchemaType } from 'mongoose'
import { DISPOSITIONS } from './Lead.js'
import { tenantScope } from '../lib/tenantScope.js'

// Mirrors Twilio's DialCallStatus values.
export const DIAL_STATUSES = [
  'initiated',
  'ringing',
  'answered',
  'completed',
  'busy',
  'no-answer',
  'failed',
  'canceled',
] as const

export const TRANSCRIPT_SPEAKERS = ['caller', 'lead', 'ai'] as const

export const CALL_DIRECTIONS = ['outbound', 'inbound'] as const
// Inbound only: who ended up on the line. `missed` = rang out, caller hung up, or the AI was unavailable.
export const INBOUND_HANDLERS = ['human', 'ai', 'missed'] as const

const isOutbound = function (this: { direction?: string }) {
  return this.direction !== 'inbound'
}

// One utterance. Speaker is not inferred — the two legs are recorded onto separate
// stereo channels and transcribed independently, so attribution is exact rather
// than a diarization guess.
const transcriptLineSchema = new Schema(
  {
    speaker: { type: String, enum: TRANSCRIPT_SPEAKERS, required: true },
    start: { type: Number, required: true },
    end: Number,
    text: { type: String, required: true },
  },
  { _id: false },
)

const transcriptSchema = new Schema(
  {
    text: { type: String, required: true },
    lines: { type: [transcriptLineSchema], default: [] },
    model: String,
    // Wall-clock seconds the transcription itself took, to spot machines that
    // cannot keep up between calls.
    processingSeconds: Number,
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
)

const callSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, immutable: true },
    direction: { type: String, enum: CALL_DIRECTIONS, default: 'outbound' },
    // An inbound caller may be nobody we have ever dialed, and an AI-handled call has no user.
    leadId: { type: Types.ObjectId, ref: 'Lead', required: isOutbound },
    userId: { type: Types.ObjectId, ref: 'User', required: isOutbound },
    username: { type: String, required: isOutbound },

    to: { type: String, required: true },
    from: String,
    parentCallSid: String,
    dialCallSid: String,

    // Which attempt on this lead this call was (1-based). Lets you measure whether
    // attempt 4 is still worth placing instead of guessing at the cadence.
    attemptNumber: Number,

    startedAt: { type: Date, default: Date.now },
    answeredAt: Date,
    endedAt: Date,

    dialStatus: { type: String, enum: DIAL_STATUSES },
    // Seconds, taken from Twilio's DialCallDuration — the lead's leg, not the browser leg.
    duration: { type: Number, default: 0 },
    disposition: { type: String, enum: DISPOSITIONS },
    dispositionLabel: String,

    handledBy: { type: String, enum: INBOUND_HANDLERS },
    // Why an inbound call was missed or how the AI session ended (receptionist reason code).
    inboundReason: String,
    fromNumber: String,
    // What the AI receptionist captured on an inbound call.
    aiSummary: {
      type: new Schema(
        {
          name: String,
          business: String,
          callbackNumber: String,
          bestTime: String,
          reason: String,
          email: String,
          notes: String,
          flags: [String],
        },
        { _id: false },
      ),
      default: undefined,
    },

    // Produced locally in the caller's browser (Whisper via WASM); audio is never
    // uploaded or stored, only the resulting text.
    transcript: transcriptSchema,
    // Browser-side call quality over the talk portion, from the Voice SDK's per-second samples.
    quality: {
      type: new Schema(
        {
          samples: Number,
          avgMicLevel: Number,
          silentMicPct: Number,
          // Inbound (lead → caller): the SDK reads these from inbound-rtp.
          maxPacketLossPct: Number,
          avgPacketLossPct: Number,
          avgMos: Number,
          maxRttMs: Number,
          avgJitterMs: Number,
          warnings: [String],
          // Outbound (caller → lead), from Twilio's RTCP reports: what the lead actually hears.
          outLossPct: Number,
          maxOutLossPct: Number,
          avgOutJitterMs: Number,
          // Our voice as sent (media-source energy, dBFS): loudest tenth of seconds, quietest tenth, peak.
          voiceDb: Number,
          voiceFloorDb: Number,
          voicePeakDb: Number,
          codec: String,
          edge: String,
          mic: {
            type: new Schema(
              { label: String, autoGainControl: Boolean, echoCancellation: Boolean, noiseSuppression: Boolean },
              { _id: false },
            ),
            default: undefined,
          },
          // `at` is seconds from the answer; negative = while ringing.
          warningEvents: {
            type: [new Schema({ name: String, at: Number, cleared: Boolean }, { _id: false })],
            default: undefined,
          },
        },
        { _id: false },
      ),
      default: undefined,
    },
    transcriptError: {
      type: new Schema(
        { stage: { type: String, required: true }, message: String, at: { type: Date, default: Date.now } },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
)

callSchema.plugin(tenantScope)

// CallSids are unique across all of Twilio, so a second row for one can only be a bug.
callSchema.index(
  { parentCallSid: 1 },
  { name: 'parentCallSid_unique', unique: true, partialFilterExpression: { parentCallSid: { $type: 'string' } } },
)
// The lookup path for webhooks and the live-call poll (about once a second per call): MongoDB
// won't use the $type-partial unique index above for an equality match.
callSchema.index({ orgId: 1, parentCallSid: 1 })
callSchema.index({ orgId: 1, startedAt: -1 })
callSchema.index({ orgId: 1, direction: 1, startedAt: -1 })
callSchema.index({ orgId: 1, leadId: 1, startedAt: -1 })
callSchema.index({ orgId: 1, fromNumber: 1 })

export type CallDoc = InferSchemaType<typeof callSchema>
export const Call = model('Call', callSchema)
