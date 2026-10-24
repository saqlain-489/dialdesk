import type { Types } from 'mongoose'
import { Organization } from '../models/Organization.js'
import { unseal, type Sealed } from './secrets.js'

export type OrgTwilio = {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  authToken: string
  twimlAppSid: string
  callerId: string
}

export type LoadedOrg = {
  id: Types.ObjectId
  slug: string
  name: string
  companyName: string
  ownerName: string
  // Null until every Twilio value has been entered with `npm run org -- set-twilio`.
  twilio: OrgTwilio | null
}

const TTL_MS = 60_000
const bySlug = new Map<string, { at: number; org: LoadedOrg | null }>()

export const secretContext = (orgId: Types.ObjectId | string, field: 'apiKeySecret' | 'authToken') => `${String(orgId)}:${field}`

type RawOrg = {
  _id: Types.ObjectId
  slug: string
  name: string
  status?: string
  brand?: { companyName?: string; ownerName?: string }
  twilio?: {
    accountSid?: string
    apiKeySid?: string
    twimlAppSid?: string
    callerId?: string
    secrets?: { apiKeySecret?: Sealed; authToken?: Sealed }
  }
}

function toLoaded(raw: RawOrg): LoadedOrg {
  const t = raw.twilio
  const complete =
    t?.accountSid && t.apiKeySid && t.twimlAppSid && t.callerId && t.secrets?.apiKeySecret && t.secrets.authToken
  return {
    id: raw._id,
    slug: raw.slug,
    name: raw.name,
    companyName: raw.brand?.companyName ?? '',
    ownerName: raw.brand?.ownerName ?? '',
    twilio: complete
      ? {
          accountSid: t.accountSid!,
          apiKeySid: t.apiKeySid!,
          twimlAppSid: t.twimlAppSid!,
          callerId: t.callerId!,
          apiKeySecret: unseal(t.secrets!.apiKeySecret!, secretContext(raw._id, 'apiKeySecret')),
          authToken: unseal(t.secrets!.authToken!, secretContext(raw._id, 'authToken')),
        }
      : null,
  }
}

// Cached briefly: every Twilio webhook and token request needs the decrypted keys, and a
// key change made with the CLI only has to be live within a minute.
export async function loadOrgBySlug(slug: string): Promise<LoadedOrg | null> {
  const hit = bySlug.get(slug)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.org
  const raw = await Organization.findOne({ slug, status: 'active' }).select('+twilio.secrets').lean<RawOrg>()
  const org = raw ? toLoaded(raw) : null
  bySlug.set(slug, { at: Date.now(), org })
  return org
}

export async function loadOrg(orgId: Types.ObjectId): Promise<LoadedOrg | null> {
  const raw = await Organization.findOne({ _id: orgId, status: 'active' }).select('slug').lean<{ slug: string }>()
  return raw ? loadOrgBySlug(raw.slug) : null
}

export async function loadOrgByCallerId(callerId: string): Promise<LoadedOrg | null> {
  const raw = await Organization.findOne({ 'twilio.callerId': callerId, status: 'active' })
    .select('slug')
    .lean<{ slug: string }>()
  return raw ? loadOrgBySlug(raw.slug) : null
}

export function voiceWebhookUrl(publicUrl: string, slug: string): string {
  return `${publicUrl}/api/twilio/o/${slug}/voice`
}
