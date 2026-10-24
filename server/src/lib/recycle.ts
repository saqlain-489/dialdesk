import type { Types } from 'mongoose'
import { env } from '../config/env.js'
import { Lead } from '../models/Lead.js'
import { isSuppressed } from './suppression.js'

// What the new workspace gets: the company, not anyone's history with it. Notes, attempts,
// outcomes and batch stay with the old tenure (whose calls keep counting in its metrics).
// hookSnippet is dropped too: a "Checked live" line is at least RECYCLE_REST_DAYS old by
// now and would have the new caller state a stale fact as verified.
const BUSINESS_FIELDS = [
  'phone',
  'businessName',
  'website',
  'bestEmail',
  'ownerName',
  'ownerLabel',
  'askForName',
  'askForRole',
  'askForNote',
  'address',
  'category',
  'rating',
  'reviewCount',
  'siteQualityScore',
  'siteYear',
  'sitePlatform',
  'siteIssues',
  'googleMapsUrl',
  'lane',
  'city',
  'state',
] as const

export function recyclableFilter(orgId: Types.ObjectId, now = new Date()) {
  return {
    orgId,
    claimed: true,
    status: 'lost',
    doNotCall: { $ne: true },
    lastDisposition: { $ne: 'wrong_number' },
    lastCalledAt: { $lte: new Date(now.getTime() - env.recycle.restDays * 86_400_000) },
    recycle: { $exists: false },
  }
}

export type RecycleOutcome = 'recycled' | 'not_eligible' | 'owned_elsewhere'

/**
 * Moves one lead to another workspace without a transaction (the local dev mongod is
 * standalone). Each step is safe to repeat:
 *   1. the old tenure gives up the claim, guarded by every eligibility rule, marked pending;
 *   2. the new tenure is inserted with the claim (a unique index on recycledFrom.leadId
 *      makes a repeat a no-op);
 *   3. the old tenure is marked done and archived.
 * A crash between steps leaves the phone owned by nobody, so nobody can dial it until
 * repairPendingRecycles() finishes the job.
 */
export async function recycleLead(
  sourceOrgId: Types.ObjectId,
  leadId: string | Types.ObjectId,
  targetOrgId: Types.ObjectId,
  now = new Date(),
): Promise<RecycleOutcome> {
  const candidate = await Lead.findOne({ _id: leadId, ...recyclableFilter(sourceOrgId, now) }, { phone: 1 })
  if (!candidate || (await isSuppressed(candidate.phone))) return 'not_eligible'

  const released = await Lead.findOneAndUpdate(
    { _id: candidate._id, ...recyclableFilter(sourceOrgId, now) },
    { $unset: { claimed: 1 }, $set: { recycle: { to: targetOrgId, state: 'pending', at: now } } },
    { new: true },
  )
  if (!released) return 'not_eligible'
  return finishRecycle(released)
}

type Released = InstanceType<typeof Lead>

async function finishRecycle(source: Released): Promise<RecycleOutcome> {
  const targetOrgId = source.recycle!.to
  const at = source.recycle!.at
  const copy: Record<string, unknown> = {
    orgId: targetOrgId,
    claimed: true,
    status: 'new',
    batch: `recycled-${at.toISOString().slice(0, 10)}`,
    recycledFrom: { orgId: source.orgId, leadId: source._id, at },
  }
  for (const field of BUSINESS_FIELDS) {
    const value = source.get(field)
    if (value !== undefined && value !== null) copy[field] = value
  }

  try {
    await Lead.create(copy)
  } catch (err) {
    const dup = err as { code?: number; keyPattern?: Record<string, unknown>; message?: string }
    if (dup.code !== 11000) throw err
    if (!dup.keyPattern?.['recycledFrom.leadId']) {
      if (dup.message?.includes('phone_1 ')) {
        await Lead.updateOne({ _id: source._id, orgId: source.orgId }, { $set: { claimed: true }, $unset: { recycle: 1 } })
        throw new Error('Recycling needs the phone-index swap first: npm run migrate:tenancy -- --swap-phone-index --apply')
      }
      // Someone else claimed the phone while it was unowned: give the claim back, or if even
      // that is taken, close this tenure so the repair pass stops retrying it.
      const key = { _id: source._id, orgId: source.orgId }
      await Lead.updateOne(key, { $set: { claimed: true }, $unset: { recycle: 1 } }).catch(() =>
        Lead.updateOne(key, { $unset: { recycle: 1 }, $set: { archivedAt: at, archivedReason: 'claimed by another workspace' } }),
      )
      return 'owned_elsewhere'
    }
  }

  await Lead.updateOne(
    { _id: source._id, orgId: source.orgId },
    { $set: { 'recycle.state': 'done', archivedAt: at, archivedReason: 'recycled' } },
  )
  return 'recycled'
}

// Finishes any recycle a crash interrupted. Runs at boot and before bulk recycles.
export async function repairPendingRecycles(): Promise<number> {
  const pending = await Lead.find({ 'recycle.state': 'pending' }).setOptions({ crossTenant: true })
  for (const source of pending) await finishRecycle(source)
  return pending.length
}
