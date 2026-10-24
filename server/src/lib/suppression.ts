import type { Types } from 'mongoose'
import { Lead } from '../models/Lead.js'
import { Suppression, SUPPRESSION_SOURCES } from '../models/Suppression.js'

type Source = (typeof SUPPRESSION_SOURCES)[number]

export async function isSuppressed(phone: string): Promise<boolean> {
  return Boolean(await Suppression.exists({ _id: phone }))
}

// Records the opt-out once for the whole brand, then mirrors it onto every workspace's copy
// of the lead so nobody else's queue still offers the number.
export async function suppress(
  phone: string,
  entry: { reason: string; source: Source; orgId?: Types.ObjectId; by?: string },
): Promise<void> {
  await Suppression.updateOne(
    { _id: phone },
    { $setOnInsert: { ...entry, at: new Date() } },
    { upsert: true },
  )
  await Lead.updateMany(
    { phone, doNotCall: { $ne: true } },
    { $set: { doNotCall: true, status: 'dnc' }, $unset: { nextCallbackAt: 1 } },
  ).setOptions({ crossTenant: true })
}

export async function suppressMany(phones: string[], entry: { reason: string; source: Source }): Promise<number> {
  if (phones.length === 0) return 0
  const result = await Suppression.bulkWrite(
    phones.map((phone) => ({
      updateOne: { filter: { _id: phone }, update: { $setOnInsert: { ...entry, at: new Date() } }, upsert: true },
    })),
  )
  await Lead.updateMany(
    { phone: { $in: phones }, doNotCall: { $ne: true } },
    { $set: { doNotCall: true, status: 'dnc' }, $unset: { nextCallbackAt: 1 } },
  ).setOptions({ crossTenant: true })
  return result.upsertedCount
}

// Owner-only. The lead's status is left alone: whoever lifts it decides where it goes next.
export async function liftSuppression(phone: string): Promise<void> {
  await Suppression.deleteOne({ _id: phone })
  await Lead.updateMany({ phone, doNotCall: true }, { $set: { doNotCall: false } }).setOptions({ crossTenant: true })
}
