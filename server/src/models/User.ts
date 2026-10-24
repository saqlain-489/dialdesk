import { Schema, model, type InferSchemaType } from 'mongoose'

export const ORG_ROLES = ['owner', 'caller'] as const
export type OrgRole = (typeof ORG_ROLES)[number]

const membershipSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    role: { type: String, enum: ORG_ROLES, required: true },
  },
  { _id: false },
)

// Logins are global so one person can belong to several workspaces; everything they
// can see is decided per request by the membership of the workspace they have open.
const userSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    // Read aloud in the script and voicemail, so it must be the name the person says.
    displayName: { type: String, required: true, trim: true },
    memberships: { type: [membershipSchema], default: [] },
    lastOrgId: { type: Schema.Types.ObjectId, ref: 'Organization' },
  },
  { timestamps: true },
)

userSchema.index({ 'memberships.orgId': 1 })

export type UserDoc = InferSchemaType<typeof userSchema>
export const User = model('User', userSchema)
