import { parseArgs } from 'node:util'
import mongoose, { type Model, type Types } from 'mongoose'
import { env } from '../config/env.js'
import { connectDb } from '../db.js'
import { Call } from '../models/Call.js'
import { Lead } from '../models/Lead.js'
import { Organization, ORG_SLUG } from '../models/Organization.js'
import { Suppression } from '../models/Suppression.js'
import { User, type OrgRole } from '../models/User.js'
import { checkTwilio, readTwilioFile, twilioUpdate, type TwilioValues } from '../lib/orgAdmin.js'
import { voiceWebhookUrl } from '../lib/orgs.js'
import { assertSecretsKey } from '../lib/secrets.js'

// Moves a single-tenant database into workspaces. Dry run unless --apply; safe to re-run
// (a second run after the deploy picks up rows the old code wrote in between).
//
//   npm run migrate:tenancy -- --owner jordan.acme:Jordan --caller sam.acme:Sam \
//     --twilio-file ./private/main-twilio.env             # preview
//   ... --apply                                           # write
//   ... --swap-phone-index --apply    # then: drop the global phone_1, enforce one owner per phone
//   ... --drop-old-indexes --apply    # then: drop indexes the schema no longer declares
//
// Back up first: mongodump --uri "$MONGO_URI" --out ./backups/<date>-pre-tenancy
// Writes go through the raw collections: Mongoose drops updates to the immutable orgId.

const { values: flags } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    slug: { type: 'string', default: 'main' },
    name: { type: 'string', default: 'Main' },
    company: { type: 'string', default: 'Acme Co.' },
    'owner-name': { type: 'string', default: 'Jordan' },
    owner: { type: 'string', multiple: true, default: [] },
    caller: { type: 'string', multiple: true, default: [] },
    'twilio-file': { type: 'string' },
    'swap-phone-index': { type: 'boolean', default: false },
    'drop-old-indexes': { type: 'boolean', default: false },
  },
})

const apply = flags.apply
const say = (line: string) => console.log(`${apply ? '' : '[dry run] '}${line}`)

function parseMember(spec: string, role: OrgRole) {
  const [username, displayName] = spec.split(':')
  if (!username || !displayName) throw new Error(`--${role} must look like username:DisplayName, got "${spec}"`)
  return { username: username.toLowerCase(), displayName, role }
}

async function ensureOrg(): Promise<Types.ObjectId | null> {
  if (!ORG_SLUG.test(flags.slug)) throw new Error('--slug must match ^[a-z0-9-]{2,32}$')
  const existing = await Organization.findOne({ slug: flags.slug }, { _id: 1 }).lean()
  if (existing) {
    say(`workspace "${flags.slug}" exists`)
    return existing._id
  }
  say(`create workspace "${flags.slug}" (${flags.name}, ${flags.company}, owner name ${flags['owner-name']})`)
  if (!apply) return null
  const org = await Organization.create({
    slug: flags.slug,
    name: flags.name,
    brand: { companyName: flags.company, ownerName: flags['owner-name'] },
  })
  return org._id
}

async function stampRows(orgId: Types.ObjectId | null): Promise<void> {
  const leads = mongoose.connection.collection('leads')
  const calls = mongoose.connection.collection('calls')
  const leadCount = await leads.countDocuments({ orgId: { $exists: false } })
  const callCount = await calls.countDocuments({ orgId: { $exists: false } })
  say(`stamp ${leadCount} leads (orgId + claimed) and ${callCount} calls with workspace "${flags.slug}"`)
  if (!apply || !orgId) return
  // Only rows without an orgId: a re-run must never re-claim a lead that was recycled away.
  await leads.updateMany({ orgId: { $exists: false } }, { $set: { orgId, claimed: true } })
  await calls.updateMany({ orgId: { $exists: false } }, { $set: { orgId } })
}

async function addMembers(orgId: Types.ObjectId | null): Promise<void> {
  const wanted = [
    ...flags.owner.map((s) => parseMember(s, 'owner')),
    ...flags.caller.map((s) => parseMember(s, 'caller')),
  ]
  for (const m of wanted) {
    const user = await User.findOne({ username: m.username }, { memberships: 1, displayName: 1 }).lean()
    if (!user) {
      say(`! no user "${m.username}" — skipped (create with set-password, then org add-member)`)
      continue
    }
    const has = orgId && user.memberships?.some((x) => x.orgId.equals(orgId))
    say(`${m.username}: ${has ? 'already a member' : `add as ${m.role}`}${user.displayName ? '' : `, display name "${m.displayName}"`}`)
    const change = {
      ...(has ? {} : { $push: { memberships: { orgId, role: m.role } } }),
      ...(user.displayName ? {} : { $set: { displayName: m.displayName } }),
    }
    if (!apply || !orgId || !Object.keys(change).length) continue
    await mongoose.connection.collection('users').updateOne({ _id: user._id }, change as Record<string, unknown>)
  }
  const homeless = await User.find({ 'memberships.0': { $exists: false } }, { username: 1 }).lean()
  const missing = homeless.filter((u) => !wanted.some((w) => w.username === u.username))
  if (missing.length) say(`! users with no workspace (cannot sign in): ${missing.map((u) => u.username).join(', ')}`)
}

// Checked before anything is written, so rejected keys never leave a half-applied run.
async function checkedTwilioValues(): Promise<TwilioValues | null> {
  if (!flags['twilio-file']) return null
  assertSecretsKey()
  const values = readTwilioFile(flags['twilio-file'])
  const expected = voiceWebhookUrl(env.publicUrl, flags.slug)
  console.log(`Checking Twilio (read-only) for ${values.accountSid} · ${values.callerId}`)
  const check = await checkTwilio(values, expected)
  for (const line of check.lines) console.log(line)
  if (!check.ok) throw new Error('Twilio values rejected; nothing written')
  return values
}

async function setTwilio(orgId: Types.ObjectId | null, values: TwilioValues | null): Promise<void> {
  if (!values) {
    say('Twilio keys: skipped (no --twilio-file)')
    return
  }
  say(`store Twilio keys on "${flags.slug}" (secrets encrypted)`)
  if (apply && orgId) await Organization.updateOne({ _id: orgId }, { $set: twilioUpdate(orgId, values) })
}

async function seedSuppressions(): Promise<void> {
  const phones = (await mongoose.connection
    .collection('leads')
    .distinct('phone', { doNotCall: true })) as string[]
  const existing = new Set((await Suppression.find({ _id: { $in: phones } }, { _id: 1 }).lean()).map((s) => s._id))
  const fresh = phones.filter((p) => !existing.has(p))
  say(`add ${fresh.length} do-not-call numbers to the brand-wide list (${existing.size} already there)`)
  if (!apply || !fresh.length) return
  await Suppression.insertMany(
    fresh.map((_id) => ({ _id, reason: 'marked do not call before workspaces', source: 'migration' })),
  )
}

type IndexSpec = [Record<string, unknown>, Record<string, unknown>]

const nameOf = ([fields, options]: IndexSpec) =>
  (options.name as string | undefined) ?? Object.entries(fields).map(([k, v]) => `${k}_${v}`).join('_')

async function syncModelIndexes(model: Model<never>, blocked: Map<string, string>): Promise<void> {
  const collection = mongoose.connection.collection(model.collection.collectionName)
  const exists = (await collection.listIndexes().toArray().catch(() => [])) as { name: string }[]
  const have = new Set(exists.map((i) => i.name))
  // Includes path-level `unique` declarations as well as schema.index() calls.
  const wanted = (model.schema.indexes() as IndexSpec[]).map((spec) => ({ spec, name: nameOf(spec) }))

  for (const { spec, name } of wanted) {
    if (have.has(name)) continue
    const why = blocked.get(`${model.modelName}.${name}`)
    if (why) {
      say(`index ${model.modelName}.${name}: held back (${why})`)
      continue
    }
    say(`create index ${model.modelName}.${name}`)
    if (apply) await collection.createIndex(spec[0] as Record<string, 1 | -1>, { ...spec[1], name })
  }

  const declared = new Set(['_id_', ...wanted.map((w) => w.name)])
  const old = exists.map((i) => i.name).filter((n) => !declared.has(n))
  if (!old.length) return
  if (!flags['drop-old-indexes']) {
    say(`old indexes on ${model.modelName} kept for now: ${old.join(', ')}`)
    return
  }
  for (const n of old) {
    say(`drop old index ${model.modelName}.${n}`)
    if (apply) await collection.dropIndex(n)
  }
}

async function indexes(): Promise<void> {
  const blocked = new Map<string, string>()
  const leadIndexes = (await mongoose.connection.collection('leads').listIndexes().toArray().catch(() => [])) as {
    name: string
  }[]
  const globalPhone = leadIndexes.some((i) => i.name === 'phone_1')

  if (globalPhone && flags['swap-phone-index']) {
    const dupes = await mongoose.connection
      .collection('leads')
      .aggregate([{ $match: { claimed: true } }, { $group: { _id: '$phone', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }])
      .toArray()
    if (dupes.length) throw new Error(`${dupes.length} phones are claimed twice; fix them before the swap`)
    say('drop leads.phone_1 (global unique) so a lead can be recycled between workspaces')
    if (apply) await mongoose.connection.collection('leads').dropIndex('phone_1')
  } else if (globalPhone) {
    blocked.set('Lead.phone_claimed_unique', 'phone_1 still enforces global uniqueness; run --swap-phone-index')
  }

  const callDupes = await mongoose.connection
    .collection('calls')
    .aggregate([
      { $match: { parentCallSid: { $type: 'string' } } },
      { $group: { _id: '$parentCallSid', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray()
  if (callDupes.length) {
    blocked.set('Call.parentCallSid_unique', `${callDupes.length} CallSids appear more than once: ${callDupes.slice(0, 5).map((d) => d._id).join(', ')}`)
  }

  for (const model of [Organization, User, Lead, Call] as unknown as Model<never>[]) {
    await syncModelIndexes(model, blocked)
  }
}

async function main(): Promise<void> {
  await connectDb()
  console.log(`target: ${mongoose.connection.host} / ${mongoose.connection.name}${apply ? '' : '   (DRY RUN — nothing is written)'}`)
  const twilioValues = await checkedTwilioValues()
  const orgId = await ensureOrg()
  await stampRows(orgId)
  await addMembers(orgId)
  await setTwilio(orgId, twilioValues)
  await seedSuppressions()
  await indexes()
  if (!apply) console.log('\nRe-run with --apply to write all of the above.')
  await mongoose.disconnect()
}

main().catch(async (err) => {
  console.error(`\nError: ${(err as Error).message}`)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
