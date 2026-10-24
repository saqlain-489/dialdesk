import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { issueStreamTicket, redeemStreamTicketClaims } from '../src/guard.js';
import { finalizeCall, flushPending, getLeadContext, queuePending } from '../src/inbound.js';
import { orgFor } from '../src/orgs.js';
import { buildInstructions, greetingFor, wrapUpInstruction } from '../src/persona.js';
import { expectedSignature, unavailableTwiml } from '../src/twilio.js';
import { fakeCtx, stubFetch, testEnv } from './helpers.js';

const HOST = 'https://dialdesk-receptionist.example.workers.dev';
const NORTH = { accountSid: `AC${'a'.repeat(32)}`, authToken: 'north-token' };
const SOUTH = { accountSid: `AC${'f'.repeat(32)}`, authToken: 'south-token' };

function orgEnv(overrides = {}) {
	return testEnv({
		LEGACY_ORG: 'north',
		DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/owner',
		ORG_CONFIG: JSON.stringify({
			north: { ...NORTH, clients: ['jordan.acme', 'sam.acme'], ownerName: 'Jordan' },
			south: {
				...SOUTH,
				clients: ['alex.acme'],
				ownerName: 'Alex',
				discordWebhookUrl: 'https://discord.com/api/webhooks/2/south',
			},
		}),
		...overrides,
	});
}

async function signed(path, params, authToken) {
	const url = `${HOST}${path}`;
	return new Request(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			'x-twilio-signature': await expectedSignature(authToken, url, params),
		},
		body: new URLSearchParams(params).toString(),
	});
}

const call = (account, extra = {}) => ({
	CallSid: 'CA200',
	AccountSid: account.accountSid,
	From: '+12125550120',
	To: '+13125550101',
	CallStatus: 'ringing',
	...extra,
});

test("a workspace's number rings that workspace's browsers and stays on its own path", async () => {
	const env = orgEnv();
	const res = await worker.fetch(await signed('/twilio/o/south/inbound', call(SOUTH), SOUTH.authToken), env, fakeCtx());
	const body = await res.text();
	assert.equal(res.status, 200);
	assert.match(body, /<Client>alex.acme<\/Client>/);
	assert.doesNotMatch(body, /jordan|sam\.acme|north/);
	assert.match(body, /action="https:\/\/dialdesk-receptionist.example.workers.dev\/twilio\/o\/south\/dial-result"/);
});

test("another account's signature, a body naming another account, or an unknown workspace are refused", async () => {
	const env = orgEnv();
	const ctx = fakeCtx();
	assert.equal((await worker.fetch(await signed('/twilio/o/south/inbound', call(SOUTH), NORTH.authToken), env, ctx)).status, 403);
	assert.equal((await worker.fetch(await signed('/twilio/o/south/inbound', call(NORTH), SOUTH.authToken), env, ctx)).status, 403);
	assert.equal((await worker.fetch(await signed('/twilio/o/nobody/inbound', call(SOUTH), SOUTH.authToken), env, ctx)).status, 403);
	assert.equal(env.RECEPTIONIST_KV.store.size, 0);
});

test('the pre-workspace paths belong to LEGACY_ORG', async () => {
	const env = orgEnv();
	const body = await (await worker.fetch(await signed('/twilio/inbound', call(NORTH), NORTH.authToken), env, fakeCtx())).text();
	assert.match(body, /<Client>sam.acme<\/Client>/);
	assert.match(body, /action="https:\/\/dialdesk-receptionist.example.workers.dev\/twilio\/dial-result"/);
});

test('lead context is kept per workspace, with the caller who last spoke to them', async () => {
	const env = orgEnv();
	const push = (body) =>
		worker.fetch(
			new Request(`${HOST}/internal/lead-context`, {
				method: 'POST',
				headers: { authorization: 'Bearer shared-secret-123', 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
			env,
			fakeCtx(),
		);
	const lead = { phone: '+12125550120', businessName: 'Cedar Dental', callerName: 'Alex<script>' };
	assert.equal((await push({ org: 'south', leads: [lead] })).status, 200);
	assert.equal((await push({ org: 'nobody', leads: [lead] })).status, 400);

	assert.deepEqual(JSON.parse(env.RECEPTIONIST_KV.store.get('lead:south:+12125550120')), {
		businessName: 'Cedar Dental',
		website: null,
		callerName: 'Alexscript',
	});
	assert.equal(await getLeadContext(env, '+12125550120', orgFor(env, 'north')), null);

	// Context written before workspaces is still read by the legacy workspace only.
	await env.RECEPTIONIST_KV.put('lead:+12125550139', JSON.stringify({ businessName: 'Old Lead' }));
	assert.equal((await getLeadContext(env, '+12125550139', orgFor(env, 'north'))).businessName, 'Old Lead');
	assert.equal(await getLeadContext(env, '+12125550139', orgFor(env, 'south')), null);
});

test("the stream ticket carries the workspace, signed", async () => {
	const env = orgEnv();
	const ticket = await issueStreamTicket('CA300', env.TICKET_SECRET, Date.now(), 'south');
	assert.equal((await redeemStreamTicketClaims(ticket, 'CA300', env)).org, 'south');
	const [body, sig] = ticket.split('.');
	const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), org: 'north' })).toString('base64url');
	assert.equal(await redeemStreamTicketClaims(`${forgedBody}.${sig}`, 'CA301', env), null);
});

test('every workspace keeps the AI disclosure and names the person who will call back', () => {
	for (const who of [undefined, { companyName: 'Acme Co.', person: 'Alex' }, { companyName: 'Other Co', person: 'Sam' }]) {
		const greeting = greetingFor({ businessName: 'Cedar Dental' }, who);
		const instructions = buildInstructions({ businessName: 'Cedar Dental' }, who);
		const person = who?.person ?? 'Jordan';
		assert.match(greeting, new RegExp(`this is Ava, ${person}'s AI assistant`));
		assert.match(instructions, new RegExp(`I'll pass a written note of this call to ${person}`));
		assert.match(instructions, /If they ask whether you're an AI: yes/);
		assert.match(wrapUpInstruction(who), new RegExp(`${person} will call them back`));
		assert.doesNotMatch(instructions, /\$\{/);
	}
	assert.match(unavailableTwiml({ companyName: 'Acme Co.', person: 'Alex' }), /Alex can&apos;t pick up/);
});

test("a workspace's call reaches dialdesk with its slug and alerts that workspace's channel", async () => {
	const env = orgEnv();
	const f = stubFetch(async () => new Response('{}'));
	try {
		const org = orgFor(env, 'south');
		await finalizeCall(env, { org: org.ingestSlug, callSid: 'CA400', from: '+12125550120', to: '+13125550101', handledBy: 'missed', reason: 'busy', startedAt: new Date().toISOString() }, { org });
	} finally {
		f.restore();
	}
	assert.equal(f.calls[0].url, 'https://discord.com/api/webhooks/2/south?wait=true');
	assert.match(JSON.parse(f.calls[0].init.body).content, /^\[south\] /);
	assert.equal(JSON.parse(f.calls[1].init.body).org, 'south');
});

test('a record dialdesk refuses is dropped with an alert instead of blocking the queue', async () => {
	const env = orgEnv();
	await queuePending(env, { callSid: 'CAbad', from: '+12125550120', to: '+12125550198', handledBy: 'missed' });
	await queuePending(env, { callSid: 'CAgood', from: '+12125550121', to: '+13125550101', handledBy: 'missed' });
	const f = stubFetch(async (url, init) => {
		if (url.includes('/api/inbound/ingest')) return new Response('{}', { status: JSON.parse(init.body).callSid === 'CAbad' ? 422 : 200 });
		return new Response('{}');
	});
	try {
		assert.deepEqual(await flushPending(env), { delivered: 1, remaining: 0 });
	} finally {
		f.restore();
	}
	assert.ok(f.calls.some((c) => c.url.startsWith('https://discord.com/api/webhooks/1/owner') && /refused/.test(JSON.parse(c.init.body).content)));
	assert.equal(env.RECEPTIONIST_KV.store.has('pending:CAbad'), false);
});

test('without ORG_CONFIG a push from any workspace lands on the single number', async () => {
	const env = testEnv();
	const res = await worker.fetch(
		new Request(`${HOST}/internal/lead-context`, {
			method: 'POST',
			headers: { authorization: 'Bearer shared-secret-123', 'content-type': 'application/json' },
			body: JSON.stringify({ org: 'north', leads: [{ phone: '+12125550120', businessName: 'Cedar Dental' }] }),
		}),
		env,
		fakeCtx(),
	);
	assert.equal(res.status, 200);
	assert.equal(JSON.parse(env.RECEPTIONIST_KV.store.get('lead:+12125550120')).businessName, 'Cedar Dental');
});
