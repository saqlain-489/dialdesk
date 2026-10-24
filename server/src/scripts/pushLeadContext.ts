import mongoose, { type Types } from 'mongoose'
import { env } from '../config/env.js'
import { connectDb } from '../db.js'
import { Call } from '../models/Call.js'
import { Lead } from '../models/Lead.js'
import { Organization } from '../models/Organization.js'
import { User } from '../models/User.js'
import { pushLeadContext } from '../lib/receptionist.js'

// Backfill: sends every workspace's dialed leads to the receptionist worker so callbacks
// are greeted by business name, under the right workspace. Safe to rerun: the worker skips
// unchanged leads, which keeps it inside the free KV write quota.
//
//   npm run push:lead-context            leads that have been called at least once
//   npm run push:lead-context -- --all   every non-archived lead

const BATCH = 200

async function lastCallers(orgId: Types.ObjectId): Promise<Map<string, string>> {
  const rows = await Call.aggregate<{ _id: Types.ObjectId; username: string }>([
    { $match: { orgId, direction: { $ne: 'inbound' } } },
    { $sort: { startedAt: -1 } },
    { $group: { _id: '$leadId', username: { $first: '$username' } } },
  ])
  const users = await User.find({ username: { $in: [...new Set(rows.map((r) => r.username))] } }, { username: 1, displayName: 1 }).lean()
  const names = new Map(users.map((u) => [u.username, u.displayName]))
  return new Map(rows.map((r) => [String(r._id), names.get(r.username) ?? '']))
}

async function main() {
  if (!env.inbound.receptionistUrl || !env.inbound.sharedSecret) {
    throw new Error('Set RECEPTIONIST_URL and INBOUND_SHARED_SECRET first')
  }
  await connectDb()
  const all = process.argv.includes('--all')

  for (const org of await Organization.find({ status: 'active' }, { slug: 1 }).lean()) {
    const leads = await Lead.find(
      { orgId: org._id, claimed: true, archivedAt: { $exists: false }, ...(all ? {} : { attempts: { $gt: 0 } }) },
      { phone: 1, businessName: 1, website: 1 },
    ).lean()
    const callers = await lastCallers(org._id)

    let written = 0
    for (let i = 0; i < leads.length; i += BATCH) {
      const chunk = leads.slice(i, i + BATCH).map((l) => ({
        phone: l.phone,
        businessName: l.businessName,
        website: l.website ?? null,
        callerName: callers.get(String(l._id)) || null,
      }))
      const result = await pushLeadContext(org.slug, chunk)
      if (!result.ok) throw new Error(`${org.slug}: push failed at batch starting ${i}`)
      written += result.written ?? 0
    }
    console.log(`receptionist ${org.slug}: ${leads.length} leads sent, ${written} written (rest unchanged)`)
  }
  await mongoose.disconnect()
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err)
  await mongoose.disconnect().catch(() => {})
  process.exit(1)
})
