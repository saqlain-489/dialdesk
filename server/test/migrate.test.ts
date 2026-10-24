import { skipWithoutMongo } from './env.js'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, describe, test } from 'node:test'
import mongoose from 'mongoose'
import { connectDb } from '../src/db.js'
import { env } from '../src/config/env.js'

const run = promisify(execFile)

// Runs the real script in a child process against this test's throwaway database.
async function migrate(...args: string[]): Promise<string> {
  const { stdout } = await run(
    process.execPath,
    ['--import', 'tsx', 'src/scripts/migrateTenancy.ts', '--owner', 'jordan.acme:Jordan', '--caller', 'sam.acme:Sam', ...args],
    { cwd: new URL('..', import.meta.url).pathname, env: process.env },
  )
  return stdout
}

const db = () => mongoose.connection.db!

before(async () => {
  if (skipWithoutMongo) return
  assert.match(env.mongoUri, /^mongodb:\/\/127\.0\.0\.1:27017\/dialdesk_test_\d+$/)
  await connectDb()
  await db().dropDatabase()
  // A database from before workspaces: no workspaces, a global role, a global unique phone index.
  await db().collection('leads').createIndex({ phone: 1 }, { unique: true })
  await db().collection('users').insertMany([
    { username: 'jordan.acme', passwordHash: 'x', role: 'admin' },
    { username: 'sam.acme', passwordHash: 'x', role: 'caller' },
  ])
  const { insertedIds } = await db().collection('leads').insertMany([
    { phone: '+12125550111', businessName: 'One', status: 'new', doNotCall: false },
    { phone: '+12125550112', businessName: 'Two', status: 'dnc', doNotCall: true },
  ])
  await db().collection('calls').insertMany([
    { leadId: insertedIds[0], username: 'jordan.acme', to: '+12125550111', parentCallSid: 'CA1' },
    { direction: 'inbound', to: '+12125550100', parentCallSid: 'CA2' },
  ])
})
after(async () => {
  if (skipWithoutMongo) return
  await db().dropDatabase()
  await mongoose.disconnect()
})

describe('migrate:tenancy', { skip: skipWithoutMongo }, () => {
  test('a bad Twilio file stops the run before anything is written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dd-migrate-'))
    const file = join(dir, 'twilio.env')
    await writeFile(file, 'TWILIO_ACCOUNT_SID=ACx\n')
    await assert.rejects(migrate('--twilio-file', file, '--apply'), /has no TWILIO_API_KEY_SID/)
    await rm(dir, { recursive: true })
    assert.equal(await db().collection('organizations').countDocuments(), 0)
    assert.equal(await db().collection('leads').countDocuments({ orgId: { $exists: true } }), 0)
  })

  test('a dry run writes nothing', async () => {
    const out = await migrate()
    assert.match(out, /DRY RUN/)
    assert.match(out, /stamp 2 leads .* and 2 calls/)
    assert.equal(await db().collection('organizations').countDocuments(), 0)
    assert.equal(await db().collection('leads').countDocuments({ orgId: { $exists: true } }), 0)
  })

  test('--apply moves everything into the workspace and keeps the global phone index for now', async () => {
    const out = await migrate('--apply')
    assert.match(out, /held back/)
    const org = await db().collection('organizations').findOne({ slug: 'main' })
    assert.ok(org)
    assert.equal(await db().collection('leads').countDocuments({ orgId: org._id, claimed: true }), 2)
    assert.equal(await db().collection('calls').countDocuments({ orgId: org._id }), 2)

    const owner = await db().collection('users').findOne({ username: 'jordan.acme' })
    assert.deepEqual(owner?.memberships, [{ orgId: org._id, role: 'owner' }])
    assert.equal(owner?.displayName, 'Jordan')
    const caller = await db().collection('users').findOne({ username: 'sam.acme' })
    assert.equal(caller?.memberships[0].role, 'caller')

    assert.ok(await db().collection('suppressions').findOne({ _id: '+12125550112' as never }))
    const names = (await db().collection('leads').indexes()).map((i) => i.name)
    assert.ok(names.includes('phone_1'))
    assert.ok(!names.includes('phone_claimed_unique'))
    assert.ok(names.includes('orgId_1_nextCallbackAt_1_attempts_1_createdAt_1__id_1'))
  })

  test('a re-run only picks up rows written in between', async () => {
    await db().collection('calls').insertOne({ direction: 'inbound', to: '+12125550100', parentCallSid: 'CA3' })
    const out = await migrate('--apply')
    assert.match(out, /stamp 0 leads .* and 1 calls/)
    assert.match(out, /already a member/)
    const owner = await db().collection('users').findOne({ username: 'jordan.acme' })
    assert.equal(owner?.memberships.length, 1)
    assert.equal(await db().collection('calls').countDocuments({ orgId: { $exists: false } }), 0)
  })

  test('--swap-phone-index replaces global uniqueness with one owner per phone', async () => {
    await migrate('--swap-phone-index', '--apply')
    const indexes = await db().collection('leads').indexes()
    const names = indexes.map((i) => i.name)
    assert.ok(!names.includes('phone_1'))
    const owned = indexes.find((i) => i.name === 'phone_claimed_unique')
    assert.equal(owned?.unique, true)
    assert.deepEqual(owned?.partialFilterExpression, { claimed: { $eq: true } })
  })
})
