import { Schema, model, type InferSchemaType } from 'mongoose'

// Lower-case and URL-safe: the slug is part of every Twilio webhook URL and receptionist
// KV key, so it can never change once a number points at it.
export const ORG_SLUG = /^[a-z0-9-]{2,32}$/
export const ORG_STATUSES = ['active', 'suspended'] as const

const sealedSchema = new Schema(
  {
    v: { type: Number, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    data: { type: String, required: true },
  },
  { _id: false },
)

const orgSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, immutable: true, match: ORG_SLUG },
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: ORG_STATUSES, default: 'active' },
    brand: {
      companyName: { type: String, required: true, trim: true },
      // Who the receptionist says a callback's note goes to when no caller is known.
      ownerName: { type: String, required: true, trim: true },
    },
    twilio: {
      accountSid: String,
      apiKeySid: String,
      twimlAppSid: String,
      callerId: String,
      // Never loaded unless asked for with select('+twilio.secrets').
      secrets: {
        type: new Schema({ apiKeySecret: sealedSchema, authToken: sealedSchema }, { _id: false }),
        select: false,
      },
    },
  },
  { timestamps: true },
)

// One Twilio account and one number per workspace: an inbound call is routed by the number
// it rang, and a browser identity is only unique inside its own account.
orgSchema.index(
  { 'twilio.accountSid': 1 },
  { unique: true, partialFilterExpression: { 'twilio.accountSid': { $type: 'string' } } },
)
orgSchema.index(
  { 'twilio.callerId': 1 },
  { unique: true, partialFilterExpression: { 'twilio.callerId': { $type: 'string' } } },
)

export type OrganizationDoc = InferSchemaType<typeof orgSchema>
export const Organization = model('Organization', orgSchema)
