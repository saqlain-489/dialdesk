import { skipWithoutMongo } from './env.js'
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import jwt from 'jsonwebtoken'
import { env } from '../src/config/env.js'
import { Call } from '../src/models/Call.js'
import { Lead } from '../src/models/Lead.js'
import { Suppression } from '../src/models/Suppression.js'
import { connectTestDb, dropTestDb, login, PHONES, seed, SIDS, startServer, switchOrg, type Client, type Seeded } from './helpers.js'

let s: Seeded
let base: string
let close: () => Promise<void>
let owner: Client
let sam: Client
let alex: Client

before(async () => {
  if (skipWithoutMongo) return
  await connectTestDb()
  s = await seed()
  ;({ base, close } = await startServer())
  owner = await login(base, 'jordan.acme')
  sam = await login(base, 'sam.acme')
  alex = await login(base, 'alex.acme')
})
after(async () => {
  if (skipWithoutMongo) return
  await close()
  await dropTestDb()
})

type Row = Record<string, unknown>

describe('sessions', { skip: skipWithoutMongo }, () => {
  test('a caller sees only their own workspace; the owner sees both', async () => {
    const me = await sam.call('/api/auth/me')
    assert.equal(me.status, 200)
    assert.deepEqual((me.body.orgs as Row[]).map((o) => o.name), ['Alpha'])
    assert.equal((me.body.org as Row).role, 'caller')
    assert.equal((me.body.user as Row).displayName, 'Sam')

    const ownerMe = await owner.call('/api/auth/me')
    assert.deepEqual((ownerMe.body.orgs as Row[]).map((o) => o.name), ['Alpha', 'Beta'])
  })

  test('a caller cannot switch into a workspace they are not in, and gets the same answer as for a made-up one', async () => {
    const real = await switchOrg(alex, String(s.alpha._id))
    const fake = await switchOrg(alex, '64b000000000000000000000')
    assert.equal(real.status, 403)
    assert.deepEqual(real, fake)
  })

  test('a stale tab gets 409 instead of writing into the other workspace', async () => {
    const tab = await login(base, 'jordan.acme')
    const staleOrg = tab.orgId
    const other = staleOrg === String(s.alpha._id) ? String(s.beta._id) : String(s.alpha._id)
    assert.equal((await switchOrg(tab, other)).status, 200)
    tab.orgId = staleOrg
    const reply = await tab.call('/api/leads/queue')
    assert.equal(reply.status, 409)
    assert.equal(reply.body.error, 'org_changed')
  })

  test('a cookie from before workspaces is upgraded, not rejected', async () => {
    const legacy = jwt.sign({ id: String(s.sam._id), username: 'sam.acme', role: 'caller' }, env.jwtSecret)
    const res = await fetch(`${base}/api/auth/me`, { headers: { cookie: `dd_session=${legacy}` } })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('set-cookie') ?? '', /dd_session=/)
    assert.equal(((await res.json()) as { org: Row }).org.name, 'Alpha')
  })

  test('removing a membership takes effect on the next request', async () => {
    const extra = await login(base, 'alex.acme')
    await (await import('../src/models/User.js')).User.updateOne({ _id: s.alex._id }, { $set: { memberships: [] } })
    assert.equal((await extra.call('/api/leads/queue')).status, 401)
    await (await import('../src/models/User.js')).User.updateOne(
      { _id: s.alex._id },
      { $set: { memberships: [{ orgId: s.beta._id, role: 'caller' }] } },
    )
  })
})

describe('data stays in its workspace', { skip: skipWithoutMongo }, () => {
  test('queue, facets and the script values are per workspace', async () => {
    const a = await sam.call('/api/leads/queue')
    const b = await alex.call('/api/leads/queue')
    assert.deepEqual((a.body.leads as Row[]).map((l) => l.businessName).sort(), ['Alpha Plumbing', 'Alpha Two Plumbing'])
    assert.deepEqual((b.body.leads as Row[]).map((l) => l.businessName), ['Beta Plumbing'])
    assert.equal(a.body.callerName, 'Sam')
    assert.equal(b.body.callerName, 'Alex')
    assert.equal(a.body.callbackNumber, '+12125550100')
    assert.equal(b.body.callbackNumber, '+13125550101')
    assert.equal(b.body.companyName, 'Acme Co.')

    const facets = await alex.call('/api/leads/facets')
    assert.deepEqual(facets.body.batches, ['Beta Plumbing-batch'])
    assert.equal(facets.body.total, 1)
  })

  test("another workspace's lead id is simply not found", async () => {
    const id = String(s.alphaLead._id)
    assert.equal((await alex.call(`/api/leads/${id}`)).status, 404)
    assert.equal((await alex.call(`/api/leads/${id}/archive`, { method: 'POST', json: {} })).status, 404)
    assert.equal(
      (await alex.call(`/api/leads/${id}/disposition`, { method: 'PATCH', json: { disposition: 'not_interested' } })).status,
      404,
    )
    assert.equal((await alex.call(`/api/leads/${id}`, { method: 'PATCH', json: { note: 'x' } })).status, 404)
    assert.equal((await alex.call('/api/leads/not-an-id')).status, 404)
    const untouched = await Lead.findOne({ orgId: s.alpha._id, _id: s.alphaLead._id })
    assert.equal(untouched?.archivedAt, undefined)
    assert.equal(untouched?.notes.length, 0)
  })

  test("another workspace's CallSid can't be read or written", async () => {
    assert.equal((await alex.call(`/api/calls/${SIDS.alphaCall}`)).status, 404)
    const put = await alex.call(`/api/calls/${SIDS.alphaCall}/transcript`, { method: 'PUT', json: { text: 'forged' } })
    assert.equal(put.status, 404)
    assert.equal((await sam.call(`/api/calls/${SIDS.alphaCall}`)).status, 200)
  })

  test('an outcome only lands on a call of the same lead', async () => {
    const reply = await sam.call(`/api/leads/${s.alphaLead2._id}/disposition`, {
      method: 'PATCH',
      json: { disposition: 'voicemail', callSid: SIDS.alphaCall },
    })
    assert.equal(reply.status, 200)
    const call = await Call.findOne({ orgId: s.alpha._id, parentCallSid: SIDS.alphaCall })
    assert.equal(call?.disposition, 'interested')
  })

  test('transcripts, the caller filter and the transcript drawer are per workspace', async () => {
    const list = await alex.call('/api/transcripts')
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.callers, ['alex.acme'])
    const texts = (list.body.rows as Row[]).map((r) => JSON.stringify(r.snippet))
    assert.ok(texts.every((t) => !t.includes('alpha')))

    const alphaIds = ((await sam.call('/api/transcripts')).body.rows as Row[]).map((r) => String(r.id))
    for (const id of alphaIds) assert.equal((await alex.call(`/api/transcripts/${id}`)).status, 404)
    assert.equal((await sam.call(`/api/transcripts/${alphaIds[0]}`)).status, 200)
  })

  test('metrics and callbacks count only the workspace, including repeat callers', async () => {
    const stats = await alex.call('/api/stats/overview')
    assert.equal(stats.status, 200)
    assert.equal((stats.body.summary as Row).calls, 1)
    assert.equal(stats.body.totalLeads, 1)
    assert.deepEqual((stats.body.byCaller as Row[]).map((c) => c.username), ['alex.acme'])
    assert.equal((stats.body.inbound as Row).total, 1)

    const callbacks = await alex.call('/api/stats/callbacks')
    const rows = callbacks.body.rows as Row[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.timesCalled, 1)
  })
})

describe('roles', { skip: skipWithoutMongo }, () => {
  test('a caller reads metrics and transcripts but cannot import, delete, restore or bulk-archive', async () => {
    assert.equal((await sam.call('/api/stats/overview')).status, 200)
    assert.equal((await sam.call('/api/transcripts')).status, 200)
    assert.equal((await sam.call('/api/stats/recent-calls')).status, 403)
    assert.equal((await sam.call(`/api/leads/${s.alphaLead._id}`, { method: 'DELETE' })).status, 403)
    assert.equal((await sam.call(`/api/leads/${s.alphaLead._id}/restore`, { method: 'POST' })).status, 403)
    assert.equal(
      (await sam.call('/api/leads/bulk-archive', { method: 'POST', json: { filter: {}, expectedCount: 0 } })).status,
      403,
    )
    const form = new FormData()
    form.append('file', new Blob(['phone\n+12125550140\n']), 'x.csv')
    assert.equal((await sam.call('/api/import/csv', { method: 'POST', body: form })).status, 403)
  })

  test('only the owner sees the Voice URL to paste into Twilio', async () => {
    assert.equal((await sam.call('/api/org/setup')).body.voiceWebhookUrl, null)
    const mine = await owner.call('/api/org/setup')
    assert.match(String(mine.body.voiceWebhookUrl), /\/api\/twilio\/o\/(alpha|beta)\/voice$/)
    assert.equal(mine.body.twilioConfigured, true)
  })

  test('a token is minted from the open workspace’s own Twilio account', async () => {
    const token = await alex.call('/api/twilio-token')
    assert.equal(token.status, 200)
    const claims = jwt.decode(String(token.body.token)) as { iss: string; sub: string; grants: { identity: string } }
    assert.equal(claims.sub, `AC${'b'.repeat(32)}`)
    assert.equal(claims.grants.identity, 'alex.acme')
  })
})

describe('do-not-call is brand-wide', { skip: skipWithoutMongo }, () => {
  test('a caller can mark do-not-call, it is suppressed for every workspace, and only the owner can lift it', async () => {
    const reply = await alex.call(`/api/leads/${s.betaLead._id}/disposition`, {
      method: 'PATCH',
      json: { disposition: 'do_not_call' },
    })
    assert.equal(reply.status, 200)
    assert.ok(await Suppression.exists({ _id: PHONES.betaLead }))

    const lift = await alex.call(`/api/leads/${s.betaLead._id}`, { method: 'PATCH', json: { doNotCall: false } })
    assert.equal(lift.status, 403)

    await switchOrg(owner, String(s.beta._id))
    const ownerLift = await owner.call(`/api/leads/${s.betaLead._id}`, { method: 'PATCH', json: { doNotCall: false } })
    assert.equal(ownerLift.status, 200)
    assert.equal(await Suppression.exists({ _id: PHONES.betaLead }), null)
  })
})
