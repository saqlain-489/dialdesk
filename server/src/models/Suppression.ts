import { Schema, model, type InferSchemaType } from 'mongoose'

export const SUPPRESSION_SOURCES = ['disposition', 'receptionist', 'email-optout', 'import', 'manual', 'migration'] as const

// The brand-wide do-not-call list, keyed by E.164 phone. Every workspace sells as the same
// company, so "stop calling me" said to one caller binds all of them. The dial allowlist
// and the importer check this, not the per-workspace lead copy.
const suppressionSchema = new Schema(
  {
    _id: { type: String, required: true },
    reason: { type: String, required: true },
    source: { type: String, enum: SUPPRESSION_SOURCES, required: true },
    // Where it was recorded; shown to the owner only.
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    by: String,
    at: { type: Date, default: Date.now },
  },
  { versionKey: false },
)

export type SuppressionDoc = InferSchemaType<typeof suppressionSchema>
export const Suppression = model('Suppression', suppressionSchema)
