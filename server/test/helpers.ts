import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import bcrypt from 'bcryptjs'
import mongoose, { type Types } from 'mongoose'
import twilio from 'twilio'
import { env } from '../src/config/env.js'
import { createApp } from '../src/app.js'
import { connectDb } from '../src/db.js'
import { twilioUpdate, type TwilioValues } from '../src/lib/orgAdmin.js'
import { Call } from '../src/models/Call.js'
import { Lead } from '../src/models/Lead.js'
import { Organization } from '../src/models/Organization.js'
import { User } from '../src/models/User.js'

export const PASSWORD = 'password123'

export const TWILIO: Record<'alpha' | 'beta', TwilioValues> = {
  alpha: {
    accountSid: `AC${'a'.repeat(32)}`,
    apiKeySid: `SK${'a'.repeat(32)}`,
    apiKeySecret: 'alpha-api-secret',
    authToken: 'alpha-auth-token',
    twimlAppSid: `AP${'a'.repeat(32)}`,
    callerId: '+12125550100',
  },
  beta: {
    accountSid: `AC${'b'.repeat(32)}`,
    apiKeySid: `SK${'b'.repeat(32)}`,
    apiKeySecret: 'beta-api-secret',
    authToken: 'beta-auth-token',
    twimlAppSid: `AP${'b'.repeat(32)}`,
    callerId: '+13125550101',
  },
}

export const PHONES = {
  alphaLead: '+12125550111',
  alphaLead2: '+12125550112',
  betaLead: '+13125550121',
  stranger: '+16465550199',
}

export const SIDS = {
  alphaCall: `CA${'1'.repeat(32)}`,
  betaCall: `CA${'2'.repeat(32)}`,
  alphaInbound: `CA${'3'.repeat(32)}`,
  betaInbound: `CA${'4'.repeat(32)}`,
}

// Tests drop their database at the end; never let that be anything but a local throwaway.
function assertLocalTestDb(): void {
  if (!/^mongodb:\/\/127\.0\.0\.1:27017\/dialdesk_test_\d+$/.test(env.mongoUri)) {
    throw new Error(`refusing to run tests against ${env.mongoUri}`)
  }
}

export async function connectTestDb(): Promise<void> {
  assertLocalTestDb()
  await connectDb({ buildSchema: true })
  await mongoose.connection.dropDatabase()
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).syncIndexes()))
}

export async function dropTestDb(): Promise<void> {
  assertLocalTestDb()
  await mongoose.connection.dropDatabase()
  await mongoose.disconnect()
}

export async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = createApp().listen(0, () => resolve(s))
  })
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

export type Seeded = Awaited<ReturnType<typeof seed>>

export async function seed() {
  const [alpha, beta] = await Promise.all([
    Organization.create({ slug: 'alpha', name: 'Alpha', brand: { companyName: 'Acme Co.', ownerName: 'Jordan' } }),
    Organization.create({ slug: 'beta', name: 'Beta', brand: { companyName: 'Acme Co.', ownerName: 'Jordan' } }),
  ])
  await Organization.updateOne({ _id: alpha._id }, { $set: twilioUpdate(alpha._id, TWILIO.alpha) })
  await Organization.updateOne({ _id: beta._id }, { $set: twilioUpdate(beta._id, TWILIO.beta) })

  const passwordHash = await bcrypt.hash(PASSWORD, 4)
  const [owner, sam, alex] = await User.create([
    {
      username: 'jordan.acme',
      displayName: 'Jordan',
      passwordHash,
      memberships: [
        { orgId: alpha._id, role: 'owner' },
        { orgId: beta._id, role: 'owner' },
      ],
    },
    { username: 'sam.acme', displayName: 'Sam', passwordHash, memberships: [{ orgId: alpha._id, role: 'caller' }] },
    { username: 'alex.acme', displayName: 'Alex', passwordHash, memberships: [{ orgId: beta._id, role: 'caller' }] },
  ])

  const lead = (orgId: Types.ObjectId, phone: string, businessName: string) =>
    Lead.create({ orgId, phone, businessName, state: 'NY', city: 'Albany', claimed: true, batch: `${businessName}-batch` })
  const alphaLead = await lead(alpha._id, PHONES.alphaLead, 'Alpha Plumbing')
  const alphaLead2 = await lead(alpha._id, PHONES.alphaLead2, 'Alpha Two Plumbing')
  const betaLead = await lead(beta._id, PHONES.betaLead, 'Beta Plumbing')

  const transcript = (text: string) => ({ text, lines: [{ speaker: 'lead', start: 0, text }] })
  await Call.create([
    {
      orgId: alpha._id,
      leadId: alphaLead._id,
      userId: sam!._id,
      username: 'sam.acme',
      to: PHONES.alphaLead,
      parentCallSid: SIDS.alphaCall,
      attemptNumber: 1,
      dialStatus: 'completed',
      duration: 60,
      disposition: 'interested',
      transcript: transcript('alpha conversation about the website'),
    },
    {
      orgId: beta._id,
      leadId: betaLead._id,
      userId: alex!._id,
      username: 'alex.acme',
      to: PHONES.betaLead,
      parentCallSid: SIDS.betaCall,
      attemptNumber: 1,
      dialStatus: 'completed',
      duration: 45,
      disposition: 'connected',
      transcript: transcript('beta conversation about the website'),
    },
    {
      orgId: alpha._id,
      direction: 'inbound',
      handledBy: 'ai',
      to: TWILIO.alpha.callerId,
      fromNumber: PHONES.stranger,
      parentCallSid: SIDS.alphaInbound,
      transcript: { text: 'Them: hello alpha', lines: [{ speaker: 'lead', start: 0, text: 'hello alpha' }] },
    },
    {
      orgId: beta._id,
      direction: 'inbound',
      handledBy: 'ai',
      to: TWILIO.beta.callerId,
      fromNumber: PHONES.stranger,
      parentCallSid: SIDS.betaInbound,
      transcript: { text: 'Them: hello beta', lines: [{ speaker: 'lead', start: 0, text: 'hello beta' }] },
    },
  ])

  return { alpha, beta, owner: owner!, sam: sam!, alex: alex!, alphaLead, alphaLead2, betaLead }
}

export type Reply = { status: number; body: Record<string, unknown> & { [k: string]: unknown } }

export type Client = {
  cookie: string
  orgId: string
  call: (path: string, init?: RequestInit & { json?: unknown; noOrgHeader?: boolean }) => Promise<Reply>
}

export async function login(base: string, username: string): Promise<Client> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  if (res.status !== 200) throw new Error(`login ${username} → ${res.status}`)
  const body = (await res.json()) as { org: { id: string } }
  const client: Client = {
    cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!,
    orgId: body.org.id,
    call: async (path, init = {}) => {
      const headers: Record<string, string> = { cookie: client.cookie }
      if (!init.noOrgHeader) headers['x-org'] = client.orgId
      if (init.json !== undefined) headers['content-type'] = 'application/json'
      const r = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      })
      const fresh = r.headers.get('set-cookie')
      if (fresh) client.cookie = fresh.split(';')[0]!
      const text = await r.text()
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { text }
      }
      return { status: r.status, body: parsed }
    },
  }
  return client
}

export async function switchOrg(client: Client, orgId: string): Promise<Reply> {
  const reply = await client.call('/api/auth/switch-org', { method: 'POST', json: { orgId }, noOrgHeader: true })
  if (reply.status === 200) client.orgId = orgId
  return reply
}

// Signs a webhook exactly as Twilio would for that account.
export async function twilioPost(
  base: string,
  path: string,
  params: Record<string, string>,
  authToken: string,
): Promise<{ status: number; text: string }> {
  const signature = twilio.getExpectedTwilioSignature(authToken, `${env.publicUrl}${path}`, params)
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body: new URLSearchParams(params).toString(),
  })
  return { status: res.status, text: await res.text() }
}
