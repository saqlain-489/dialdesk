import { parseArgs } from 'node:util'
import mongoose from 'mongoose'
import { env } from '../config/env.js'
import { connectDb } from '../db.js'
import { Organization, ORG_SLUG } from '../models/Organization.js'
import { User, ORG_ROLES, type OrgRole } from '../models/User.js'
import { checkTwilio, readTwilioFile, twilioUpdate } from '../lib/orgAdmin.js'
import { voiceWebhookUrl } from '../lib/orgs.js'
import { assertSecretsKey } from '../lib/secrets.js'

// Workspace admin. Every command that writes only shows what it would do unless --apply.
//
//   npm run org -- list
//   npm run org -- create north --name "North team" --company "Acme Co." --owner-name Jordan
//   npm run org -- add-member north jordan.acme --role owner
//   npm run org -- add-member north sam.acme --role caller
//   npm run org -- remove-member north someone.acme
//   npm run org -- set-twilio north --from-file ./private/north-twilio.env
//
// It writes to whatever MONGO_URI points at (server/.env); the target is printed first.

const USAGE = 'usage: npm run org -- <list|create|add-member|remove-member|set-twilio> [args] [--apply]'

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    apply: { type: 'boolean', default: false },
    name: { type: 'string' },
    company: { type: 'string', default: 'Acme Co.' },
    'owner-name': { type: 'string', default: 'Jordan' },
    role: { type: 'string' },
    'from-file': { type: 'string' },
  },
})

const [command, slug, username] = positionals

function done(message: string): void {
  console.log(flags.apply ? message : `DRY RUN: ${message}\nRe-run with --apply to write it.`)
}

async function orgOrThrow(s: string | undefined) {
  if (!s) throw new Error(USAGE)
  const org = await Organization.findOne({ slug: s })
  if (!org) throw new Error(`no workspace "${s}"`)
  return org
}

async function list(): Promise<void> {
  const orgs = await Organization.find().sort({ slug: 1 }).lean()
  const users = await User.find({}, { username: 1, displayName: 1, memberships: 1 }).lean()
  if (!orgs.length) console.log('No workspaces yet.')
  for (const org of orgs) {
    const t = org.twilio
    console.log(`\n${org.slug}  "${org.name}"  ${org.status}  company="${org.brand?.companyName}"`)
    console.log(`  twilio: ${t?.accountSid ? `${t.accountSid} · ${t.callerId} · app ${t.twimlAppSid}` : 'not set'}`)
    console.log(`  voice url: ${voiceWebhookUrl(env.publicUrl, org.slug)}`)
    for (const u of users) {
      const m = u.memberships.find((x) => x.orgId.equals(org._id))
      if (m) console.log(`  ${m.role.padEnd(6)} ${u.username} (${u.displayName})`)
    }
  }
  const homeless = users.filter((u) => !u.memberships.length)
  if (homeless.length) console.log(`\nNo workspace (cannot sign in): ${homeless.map((u) => u.username).join(', ')}`)
}

async function create(): Promise<void> {
  if (!slug || !ORG_SLUG.test(slug)) throw new Error('slug must match ^[a-z0-9-]{2,32}$')
  if (!flags.name) throw new Error('--name is required')
  if (await Organization.exists({ slug })) throw new Error(`workspace "${slug}" already exists`)
  const doc = { slug, name: flags.name, brand: { companyName: flags.company, ownerName: flags['owner-name'] } }
  if (flags.apply) await Organization.create(doc)
  done(`create workspace ${JSON.stringify(doc)}`)
}

async function addMember(): Promise<void> {
  const org = await orgOrThrow(slug)
  const role = flags.role as OrgRole
  if (!ORG_ROLES.includes(role)) throw new Error(`--role must be one of: ${ORG_ROLES.join(', ')}`)
  const user = await User.findOne({ username: username?.toLowerCase() })
  if (!user) throw new Error(`no user "${username}" — create it first: npm --prefix server run set-password`)
  const current = user.memberships.find((m) => m.orgId.equals(org._id))
  if (current?.role === role) {
    console.log(`${user.username} is already ${role} of ${org.slug}`)
    return
  }
  if (flags.apply && current) {
    await User.updateOne({ _id: user._id, 'memberships.orgId': org._id }, { $set: { 'memberships.$.role': role } })
  } else if (flags.apply) {
    await User.updateOne({ _id: user._id }, { $push: { memberships: { orgId: org._id, role } } })
  }
  done(`${user.username} → ${role} of ${org.slug}${current ? ` (was ${current.role})` : ''}`)
}

async function removeMember(): Promise<void> {
  const org = await orgOrThrow(slug)
  const user = await User.findOne({ username: username?.toLowerCase() })
  if (!user?.memberships.some((m) => m.orgId.equals(org._id))) throw new Error(`${username} is not in ${org.slug}`)
  if (flags.apply) {
    await User.updateOne({ _id: user._id }, { $pull: { memberships: { orgId: org._id } } })
  }
  done(`remove ${user.username} from ${org.slug} (takes effect on their next request)`)
}

async function setTwilio(): Promise<void> {
  assertSecretsKey()
  const org = await orgOrThrow(slug)
  if (!flags['from-file']) throw new Error('--from-file <path> is required (TWILIO_* lines, same as server/.env)')
  const values = readTwilioFile(flags['from-file'])

  const taken = await Organization.findOne({
    _id: { $ne: org._id },
    $or: [{ 'twilio.accountSid': values.accountSid }, { 'twilio.callerId': values.callerId }],
  }).lean()
  if (taken) throw new Error(`that Twilio account or number already belongs to workspace "${taken.slug}"`)

  const expected = voiceWebhookUrl(env.publicUrl, org.slug)
  console.log(`Checking with Twilio (read-only) for ${org.slug} · ${values.accountSid} · ${values.callerId}`)
  const check = await checkTwilio(values, expected)
  for (const line of check.lines) console.log(line)
  if (!check.ok) throw new Error('fix the values above, then re-run')

  if (flags.apply) await Organization.updateOne({ _id: org._id }, { $set: twilioUpdate(org._id, values) })
  done(`store ${org.slug}'s Twilio keys (secrets encrypted). TwiML App Voice URL must be: ${expected}`)
}

async function main(): Promise<void> {
  const commands: Record<string, () => Promise<void>> = {
    list,
    create,
    'add-member': addMember,
    'remove-member': removeMember,
    'set-twilio': setTwilio,
  }
  const run = command ? commands[command] : undefined
  if (!run) throw new Error(USAGE)
  await connectDb()
  console.log(`target: ${mongoose.connection.host} / ${mongoose.connection.name}`)
  await run()
  await mongoose.disconnect()
}

main().catch(async (err) => {
  console.error(`\nError: ${(err as Error).message}`)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
