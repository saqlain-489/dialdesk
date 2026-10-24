import { skipWithoutMongo } from './env.js'
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { Call } from '../src/models/Call.js'
import { Lead } from '../src/models/Lead.js'
import { suppress } from '../src/lib/suppression.js'
import { connectTestDb, dropTestDb, PHONES, seed, startServer, TWILIO, twilioPost, type Seeded } from './helpers.js'

let s: Seeded
let base: string
let close: () => Promise<void>
let sid = 100

before(async () => {
  if (skipWithoutMongo) return
  await connectTestDb()
  s = await seed()
  ;({ base, close } = await startServer())
})
after(async () => {
  if (skipWithoutMongo) return
  await close()
  await dropTestDb()
})

const nextSid = () => `CA${String(sid++).padStart(32, '0')}`

function voice(org: 'alpha' | 'beta', leadPhone: string, identity: string, overrides: Record<string, string> = {}) {
  return {
    CallSid: nextSid(),
    AccountSid: TWILIO[org].accountSid,
    From: `client:${identity}`,
    LeadPhone: leadPhone,
    ...overrides,
  }
}

describe('voice webhook', { skip: skipWithoutMongo }, () => {
  test("dials the workspace's own lead from the workspace's own number", async () => {
    const params = voice('beta', PHONES.betaLead, 'alex.acme')
    const res = await twilioPost(base, '/api/twilio/o/beta/voice', params, TWILIO.beta.authToken)
    assert.equal(res.status, 200)
    assert.match(res.text, /<Dial[^>]*callerId="\+13125550101"/)
    assert.match(res.text, /answerOnBridge="true"/)
    assert.match(res.text, /\/api\/twilio\/o\/beta\/dial-status/)
    const call = await Call.findOne({ orgId: s.beta._id, parentCallSid: params.CallSid })
    assert.equal(call?.username, 'alex.acme')
    assert.equal(call?.attemptNumber, 1)
  })

  test("another account's signature, a mismatched AccountSid or an unknown workspace are all 403", async () => {
    const params = voice('alpha', PHONES.alphaLead, 'sam.acme')
    assert.equal((await twilioPost(base, '/api/twilio/o/alpha/voice', params, TWILIO.beta.authToken)).status, 403)
    const wrongAccount = { ...params, AccountSid: TWILIO.beta.accountSid }
    assert.equal((await twilioPost(base, '/api/twilio/o/alpha/voice', wrongAccount, TWILIO.alpha.authToken)).status, 403)
    assert.equal((await twilioPost(base, '/api/twilio/o/nobody/voice', params, TWILIO.alpha.authToken)).status, 403)
  })

  test("one workspace's number can't dial another workspace's lead", async () => {
    const params = voice('beta', PHONES.alphaLead, 'jordan.acme')
    const res = await twilioPost(base, '/api/twilio/o/beta/voice', params, TWILIO.beta.authToken)
    assert.match(res.text, /not in the lead list/)
    assert.doesNotMatch(res.text, /<Dial/)
    assert.equal((await Lead.findOne({ orgId: s.alpha._id, _id: s.alphaLead._id }))?.attempts, 0)
  })

  test('a caller who is not in the workspace is refused', async () => {
    const res = await twilioPost(base, '/api/twilio/o/alpha/voice', voice('alpha', PHONES.alphaLead, 'alex.acme'), TWILIO.alpha.authToken)
    assert.match(res.text, /not a member/)
  })

  test('the pre-workspace path still works and belongs to LEGACY_WEBHOOK_ORG', async () => {
    const res = await twilioPost(base, '/api/twilio/voice', voice('alpha', PHONES.alphaLead2, 'sam.acme'), TWILIO.alpha.authToken)
    assert.match(res.text, /callerId="\+12125550100"/)
    assert.match(res.text, /\/api\/twilio\/o\/alpha\/number-status/)
  })

  test('a number on the brand-wide do-not-call list is refused in every workspace', async () => {
    await suppress(PHONES.alphaLead, { reason: 'test', source: 'manual' })
    const res = await twilioPost(base, '/api/twilio/o/alpha/voice', voice('alpha', PHONES.alphaLead, 'sam.acme'), TWILIO.alpha.authToken)
    assert.match(res.text, /do not call/)
  })
})

describe('status callbacks', { skip: skipWithoutMongo }, () => {
  test("a dial result only updates the workspace's own call", async () => {
    const params = voice('beta', PHONES.betaLead, 'alex.acme')
    await twilioPost(base, '/api/twilio/o/beta/voice', params, TWILIO.beta.authToken)

    const forged = { CallSid: params.CallSid, AccountSid: TWILIO.alpha.accountSid, DialCallStatus: 'busy', DialCallDuration: '0' }
    assert.equal((await twilioPost(base, '/api/twilio/o/alpha/dial-status', forged, TWILIO.alpha.authToken)).status, 200)
    assert.equal((await Call.findOne({ orgId: s.beta._id, parentCallSid: params.CallSid }))?.dialStatus, 'initiated')

    const real = { ...forged, AccountSid: TWILIO.beta.accountSid, DialCallStatus: 'completed', DialCallDuration: '42' }
    await twilioPost(base, '/api/twilio/o/beta/dial-status', real, TWILIO.beta.authToken)
    const call = await Call.findOne({ orgId: s.beta._id, parentCallSid: params.CallSid })
    assert.equal(call?.dialStatus, 'completed')
    assert.equal(call?.duration, 42)
  })
})
