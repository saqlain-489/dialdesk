import { skipWithoutMongo } from './env.js'
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { Call } from '../src/models/Call.js'
import { Lead } from '../src/models/Lead.js'
import { repairPendingRecycles } from '../src/lib/recycle.js'
import {
  connectTestDb,
  dropTestDb,
  login,
  PHONES,
  seed,
  startServer,
  switchOrg,
  TWILIO,
  twilioPost,
  type Client,
  type Seeded,
} from './helpers.js'

let s: Seeded
let base: string
let close: () => Promise<void>
let owner: Client
let sam: Client
let alex: Client

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

async function workedOut(orgId: unknown, id: unknown, restedDays: number) {
  await Lead.updateOne(
    { _id: id, orgId },
    {
      $set: {
        status: 'lost',
        attempts: 5,
        lastDisposition: 'no_answer',
        lastCalledAt: daysAgo(restedDays),
        hookSnippet: 'Checked live 2026-08-01: site is down',
        notes: [{ body: 'Auto-closed after 5 attempts without a result.', author: 'system', at: daysAgo(restedDays) }],
      },
    },
  )
}

before(async () => {
  if (skipWithoutMongo) return
  await connectTestDb()
  s = await seed()
  ;({ base, close } = await startServer())
  await workedOut(s.alpha._id, s.alphaLead._id, 70)
  await workedOut(s.alpha._id, s.alphaLead2._id, 10)
  owner = await login(base, 'jordan.acme')
  if (owner.orgId !== String(s.alpha._id)) await switchOrg(owner, String(s.alpha._id))
  sam = await login(base, 'sam.acme')
  alex = await login(base, 'alex.acme')
})
after(async () => {
  if (skipWithoutMongo) return
  await close()
  await dropTestDb()
})

type Row = Record<string, unknown>

describe('recycling a worked-out lead', { skip: skipWithoutMongo }, () => {
  test('only lost leads rested long enough are offered', async () => {
    const list = await owner.call('/api/leads/queue?view=recyclable')
    assert.deepEqual((list.body.leads as Row[]).map((l) => l.businessName), ['Alpha Plumbing'])
  })

  test('a caller cannot move leads, and a lead that has not rested is refused', async () => {
    const asCaller = await sam.call(`/api/leads/${s.alphaLead._id}/recycle`, { method: 'POST', json: { orgId: String(s.beta._id) } })
    assert.equal(asCaller.status, 403)
    const tooSoon = await owner.call(`/api/leads/${s.alphaLead2._id}/recycle`, { method: 'POST', json: { orgId: String(s.beta._id) } })
    assert.equal(tooSoon.status, 409)
    const sameOrg = await owner.call(`/api/leads/${s.alphaLead._id}/recycle`, { method: 'POST', json: { orgId: String(s.alpha._id) } })
    assert.equal(sameOrg.status, 400)
  })

  test('it starts over in the new workspace with no history, and the old calls stay put', async () => {
    const reply = await owner.call(`/api/leads/${s.alphaLead._id}/recycle`, { method: 'POST', json: { orgId: String(s.beta._id) } })
    assert.equal(reply.status, 200)

    const old = await Lead.findOne({ _id: s.alphaLead._id, orgId: s.alpha._id })
    assert.equal(old?.claimed, undefined)
    assert.equal(old?.recycle?.state, 'done')
    assert.equal(old?.archivedReason, 'recycled')
    assert.equal(await Call.countDocuments({ orgId: s.alpha._id, leadId: s.alphaLead._id }), 1)

    const fresh = await Lead.findOne({ orgId: s.beta._id, phone: PHONES.alphaLead })
    assert.equal(fresh?.claimed, true)
    assert.equal(fresh?.status, 'new')
    assert.equal(fresh?.attempts, 0)
    assert.equal(fresh?.notes.length, 0)
    assert.equal(fresh?.hookSnippet, undefined)
    assert.equal(fresh?.businessName, 'Alpha Plumbing')
  })

  test('the new caller sees a brand-new lead; only the owner sees where it came from', async () => {
    const queue = await alex.call('/api/leads/queue')
    const row = (queue.body.leads as Row[]).find((l) => l.phone === PHONES.alphaLead)
    assert.ok(row)
    assert.equal('recycledFrom' in row, false)
    assert.equal(row.attempts, 0)
    assert.deepEqual(row.notes, [])
    const history = await alex.call(`/api/leads/${row.id}`)
    assert.deepEqual(history.body.calls, [])

    const asOwner = await login(base, 'jordan.acme')
    if (asOwner.orgId !== String(s.beta._id)) await switchOrg(asOwner, String(s.beta._id))
    const ownerRow = ((await asOwner.call('/api/leads/queue')).body.leads as Row[]).find((l) => l.phone === PHONES.alphaLead)
    assert.equal((ownerRow?.recycledFrom as Row).orgId, String(s.alpha._id))
  })

  test('the old workspace can no longer dial or work it; the new one can', async () => {
    assert.equal(((await sam.call('/api/leads/queue')).body.leads as Row[]).some((l) => l.phone === PHONES.alphaLead), false)
    const outcome = await sam.call(`/api/leads/${s.alphaLead._id}/disposition`, { method: 'PATCH', json: { disposition: 'voicemail' } })
    assert.equal(outcome.status, 404)

    const oldDial = await twilioPost(
      base,
      '/api/twilio/o/alpha/voice',
      { CallSid: `CA${'9'.repeat(32)}`, AccountSid: TWILIO.alpha.accountSid, From: 'client:sam.acme', LeadPhone: PHONES.alphaLead },
      TWILIO.alpha.authToken,
    )
    assert.match(oldDial.text, /not in the lead list/)
    const newDial = await twilioPost(
      base,
      '/api/twilio/o/beta/voice',
      { CallSid: `CA${'8'.repeat(32)}`, AccountSid: TWILIO.beta.accountSid, From: 'client:alex.acme', LeadPhone: PHONES.alphaLead },
      TWILIO.beta.authToken,
    )
    assert.match(newDial.text, /<Dial/)
  })

  test('a callback to the old number is logged there but never reopens the moved lead', async () => {
    const res = await fetch(`${base}/api/inbound/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-inbound-secret' },
      body: JSON.stringify({ callSid: `CA${'7'.repeat(32)}`, handledBy: 'ai', from: PHONES.alphaLead, to: TWILIO.alpha.callerId }),
    })
    assert.equal(res.status, 200)
    const old = await Lead.findOne({ _id: s.alphaLead._id, orgId: s.alpha._id })
    assert.equal(old?.status, 'lost')
    assert.equal(old?.archivedReason, 'recycled')
    assert.equal(old?.notes.length, 1)
  })

  test('it can come back later as a new tenure, while the first one stays archived', async () => {
    const tenure = await Lead.findOne({ orgId: s.beta._id, phone: PHONES.alphaLead })
    await workedOut(s.beta._id, tenure!._id, 90)
    const asOwner = await login(base, 'jordan.acme')
    if (asOwner.orgId !== String(s.beta._id)) await switchOrg(asOwner, String(s.beta._id))
    const back = await asOwner.call(`/api/leads/${tenure!._id}/recycle`, { method: 'POST', json: { orgId: String(s.alpha._id) } })
    assert.equal(back.status, 200)

    const alphaDocs = await Lead.find({ orgId: s.alpha._id, phone: PHONES.alphaLead }).sort({ createdAt: 1 })
    assert.equal(alphaDocs.length, 2)
    assert.equal(alphaDocs[0]!.archivedReason, 'recycled')
    assert.equal(alphaDocs[1]!.claimed, true)
    assert.equal(await Lead.countDocuments({ phone: PHONES.alphaLead, claimed: true }).setOptions({ crossTenant: true }), 1)
  })

  test('an interrupted recycle is finished by the repair pass, once', async () => {
    await Lead.updateOne(
      { _id: s.alphaLead2._id, orgId: s.alpha._id },
      { $unset: { claimed: 1 }, $set: { recycle: { to: s.beta._id, state: 'pending', at: new Date() } } },
    )
    assert.equal(await repairPendingRecycles(), 1)
    assert.equal(await repairPendingRecycles(), 0)
    assert.equal(await Lead.countDocuments({ orgId: s.beta._id, phone: PHONES.alphaLead2, claimed: true }), 1)
  })
})

describe('bulk recycling', { skip: skipWithoutMongo }, () => {
  test('is guarded by the count on screen', async () => {
    const extra = await Lead.create({ orgId: s.alpha._id, phone: '+12125550150', businessName: 'Bulk One', state: 'NY', claimed: true })
    await workedOut(s.alpha._id, extra._id, 120)

    const wrong = await owner.call('/api/leads/bulk-recycle', { method: 'POST', json: { filter: {}, expectedCount: 5, orgId: String(s.beta._id) } })
    assert.equal(wrong.status, 409)
    const right = await owner.call('/api/leads/bulk-recycle', { method: 'POST', json: { filter: {}, expectedCount: 1, orgId: String(s.beta._id) } })
    assert.equal(right.status, 200)
    assert.equal(right.body.recycled, 1)
    assert.equal(await Lead.countDocuments({ orgId: s.beta._id, phone: '+12125550150', claimed: true }), 1)
  })
})
