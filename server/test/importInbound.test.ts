import { skipWithoutMongo } from './env.js'
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { Call } from '../src/models/Call.js'
import { Lead } from '../src/models/Lead.js'
import { Suppression } from '../src/models/Suppression.js'
import { suppress } from '../src/lib/suppression.js'
import { connectTestDb, dropTestDb, login, PHONES, seed, startServer, switchOrg, TWILIO, type Client, type Seeded } from './helpers.js'

let s: Seeded
let base: string
let close: () => Promise<void>
let owner: Client

before(async () => {
  if (skipWithoutMongo) return
  await connectTestDb()
  s = await seed()
  ;({ base, close } = await startServer())
  owner = await login(base, 'jordan.acme')
  await switchOrg(owner, String(s.beta._id))
})
after(async () => {
  if (skipWithoutMongo) return
  await close()
  await dropTestDb()
})

async function importCsv(csv: string) {
  const form = new FormData()
  form.append('file', new Blob([csv]), 'batch.csv')
  form.append('batch', 'test-batch')
  return owner.call('/api/import/csv', { method: 'POST', body: form })
}

describe('import', { skip: skipWithoutMongo }, () => {
  test('lands in the open workspace and skips companies owned elsewhere or on do-not-call', async () => {
    await suppress('+12125550142', { reason: 'test', source: 'manual' })
    const reply = await importCsv(
      [
        'business_name,phone,state,do_not_contact',
        `Taken By Alpha,${PHONES.alphaLead},NY,`,
        'Fresh Plumbing,(212) 555-0141,NY,',
        'Suppressed Plumbing,212-555-0142,NY,',
        'Opted Out Plumbing,212-555-0143,NY,yes',
        `Beta Again,${PHONES.betaLead},NY,`,
      ].join('\n'),
    )
    assert.equal(reply.status, 200)
    assert.equal(reply.body.imported, 1)
    assert.equal(reply.body.updated, 1)
    assert.equal(reply.body.skippedOwnedElsewhere, 1)
    assert.equal(reply.body.skippedDoNotCall, 2)

    const fresh = await Lead.findOne({ orgId: s.beta._id, phone: '+12125550141' })
    assert.equal(fresh?.claimed, true)
    assert.equal(fresh?.batch, 'test-batch')
    assert.equal(await Lead.countDocuments({ orgId: s.beta._id, phone: PHONES.alphaLead }), 0)
    assert.ok(await Suppression.exists({ _id: '+12125550143' }))
  })

  test('keeps where the owner name came from, so a registered agent is not read as the owner', async () => {
    const reply = await importCsv(
      ['business_name,phone,state,owner_name,owner_label', 'Agent Plumbing,212-555-0144,NY,Pat Morgan,"registered agent, unconfirmed"'].join('\n'),
    )
    assert.equal(reply.status, 200)
    const lead = await Lead.findOne({ orgId: s.beta._id, phone: '+12125550144' })
    assert.equal(lead?.ownerName, 'Pat Morgan')
    assert.equal(lead?.ownerLabel, 'registered agent, unconfirmed')
  })

  test('the database refuses a second owner even if the importer were bypassed', async () => {
    await assert.rejects(
      Lead.create({ orgId: s.beta._id, phone: PHONES.alphaLead, businessName: 'Sneaky', claimed: true }),
      (err: { code?: number }) => err.code === 11000,
    )
  })
})

describe('inbound ingest', { skip: skipWithoutMongo }, () => {
  const ingest = (body: Record<string, unknown>) =>
    fetch(`${base}/api/inbound/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-inbound-secret' },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }))

  test('is routed by the number that rang, and matches only that workspace’s leads', async () => {
    const callSid = `CA${'5'.repeat(32)}`
    const reply = await ingest({ callSid, handledBy: 'missed', from: PHONES.alphaLead, to: TWILIO.beta.callerId, org: 'beta' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.leadMatched, false)
    const call = await Call.findOne({ orgId: s.beta._id, parentCallSid: callSid })
    assert.equal(call?.direction, 'inbound')
    assert.equal(await Call.countDocuments({ orgId: s.alpha._id, parentCallSid: callSid }), 0)

    const own = await ingest({ callSid: `CA${'6'.repeat(32)}`, handledBy: 'ai', from: PHONES.alphaLead, to: TWILIO.alpha.callerId })
    assert.equal(own.body.leadMatched, true)
    const lead = await Lead.findOne({ orgId: s.alpha._id, _id: s.alphaLead._id })
    assert.equal(lead?.status, 'callback')
  })

  test('an unknown number or a workspace that disagrees with the number is refused permanently', async () => {
    assert.equal((await ingest({ callSid: `CA${'7'.repeat(32)}`, handledBy: 'ai', to: '+12125550198' })).status, 422)
    assert.equal(
      (await ingest({ callSid: `CA${'7'.repeat(32)}`, handledBy: 'ai', to: TWILIO.alpha.callerId, org: 'beta' })).status,
      422,
    )
  })

  test("the receptionist's do-not-call flag suppresses the number for the whole brand", async () => {
    await ingest({
      callSid: `CA${'8'.repeat(32)}`,
      handledBy: 'ai',
      from: PHONES.alphaLead2,
      to: TWILIO.alpha.callerId,
      aiSummary: { flags: ['do_not_call'] },
    })
    assert.ok(await Suppression.exists({ _id: PHONES.alphaLead2 }))
    assert.equal((await Lead.findOne({ orgId: s.alpha._id, _id: s.alphaLead2._id }))?.doNotCall, true)
  })
})
