import { skipWithoutMongo } from './env.js'
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import mongoose from 'mongoose'
import { Call } from '../src/models/Call.js'
import { Lead } from '../src/models/Lead.js'
import { TenantScopeError } from '../src/lib/tenantScope.js'
import { connectTestDb, dropTestDb, seed, type Seeded } from './helpers.js'

let s: Seeded

before(async () => {
  if (skipWithoutMongo) return
  await connectTestDb()
  s = await seed()
})
after(async () => {
  if (skipWithoutMongo) return
  await dropTestDb()
})

const rejects = (p: Promise<unknown>) => assert.rejects(p, TenantScopeError)

describe('tenant guard', { skip: skipWithoutMongo }, () => {
  test('refuses reads and writes that do not name a workspace', async () => {
    await rejects(Lead.find({ phone: s.alphaLead.phone }).exec())
    await rejects(Lead.findById(s.alphaLead._id).exec())
    await rejects(Lead.countDocuments().exec())
    await rejects(Lead.distinct('city').exec())
    await rejects(Lead.updateMany({}, { $set: { city: 'x' } }).exec())
    await rejects(Lead.deleteOne({ _id: s.alphaLead._id }).exec())
    await rejects(Call.findOne({ parentCallSid: 'CA' }).exec())
    await rejects(Lead.estimatedDocumentCount().exec())
  })

  test('only a real ObjectId at the top level counts as a scope', async () => {
    await rejects(Lead.find({ orgId: String(s.alpha._id) }).exec())
    await rejects(Lead.find({ orgId: { $in: [s.alpha._id, s.beta._id] } }).exec())
    await rejects(Lead.find({ orgId: undefined }).exec())
    await rejects(Lead.find({ $or: [{ orgId: s.alpha._id }] }).exec())
  })

  test('aggregate must start by matching the workspace', async () => {
    await rejects(Lead.aggregate([{ $group: { _id: '$status' } }]).exec())
    await rejects(Lead.aggregate([{ $sort: { _id: 1 } }, { $match: { orgId: s.alpha._id } }]).exec())
    const rows = await Lead.aggregate([{ $match: { orgId: s.alpha._id } }, { $count: 'n' }])
    assert.equal(rows[0].n, 2)
  })

  test('populate must carry the workspace in its match', async () => {
    await rejects(Call.findOne({ orgId: s.alpha._id, direction: 'outbound' }).populate('leadId').exec())
    const call = await Call.findOne({ orgId: s.alpha._id, direction: 'outbound' }).populate({
      path: 'leadId',
      match: { orgId: s.alpha._id },
    })
    assert.equal((call?.leadId as unknown as { businessName: string }).businessName, 'Alpha Plumbing')
  })

  test('bulkWrite and unscoped insertMany are refused', async () => {
    await assert.rejects(Lead.bulkWrite([{ deleteMany: { filter: {} } }]), TenantScopeError)
    await assert.rejects(Lead.insertMany([{ phone: '+12125550188', businessName: 'x' }]), TenantScopeError)
  })

  test('crossTenant is explicit, works, and never reaches the server', async () => {
    const both = await Lead.find({ phone: { $in: [s.alphaLead.phone, s.betaLead.phone] } }).setOptions({ crossTenant: true })
    assert.equal(both.length, 2)
    // The option is consumed by the guard, so the next query on the same model is checked again.
    await rejects(Lead.find({}).exec())
  })

  test('scoped queries return only that workspace', async () => {
    assert.equal(await Lead.countDocuments({ orgId: s.alpha._id }), 2)
    assert.equal(await Lead.countDocuments({ orgId: s.beta._id }), 1)
    assert.equal(mongoose.connection.readyState, 1)
  })
})
