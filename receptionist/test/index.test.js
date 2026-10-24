import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { expectedSignature } from '../src/twilio.js';
import { fakeCtx, stubFetch, testEnv } from './helpers.js';

const HOST = 'https://dialdesk-receptionist.example.workers.dev';
const CALL = { CallSid: 'CA100', From: '+12125550120', To: '+12125550100', CallStatus: 'ringing' };

async function signed(path, params, env, { signature } = {}) {
	const url = `${HOST}${path}`;
	const body = new URLSearchParams(params).toString();
	const sig = signature ?? (await expectedSignature(env.TWILIO_AUTH_TOKEN, url, params));
	return new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig },
		body,
	});
}

test('unsigned or forged Twilio webhooks are refused on every route', async () => {
	const env = testEnv();
	for (const path of ['/twilio/inbound', '/twilio/dial-result', '/twilio/ai', '/twilio/status', '/twilio/sms']) {
		const forged = await worker.fetch(await signed(path, CALL, env, { signature: 'forged=' }), env, fakeCtx());
		assert.equal(forged.status, 403, path);
		const get = await worker.fetch(new Request(`${HOST}${path}`), env, fakeCtx());
		assert.equal(get.status, 403, `${path} GET`);
	}
	assert.equal(env.RECEPTIONIST_KV.store.size, 0, 'a refused request writes nothing');
});

test('inbound rings the browser first', async () => {
	const env = testEnv();
	const res = await worker.fetch(await signed('/twilio/inbound', CALL, env), env, fakeCtx());
	assert.equal(res.status, 200);
	assert.match(res.headers.get('content-type'), /text\/xml/);
	const body = await res.text();
	assert.match(body, /<Client>jordan.acme<\/Client>/);
	assert.match(body, /action="https:\/\/dialdesk-receptionist.example.workers.dev\/twilio\/dial-result"/);
});

test('inbound with no browser identities goes straight to the AI', async () => {
	const env = testEnv({ INBOUND_CLIENTS: '' });
	const body = await (await worker.fetch(await signed('/twilio/inbound', CALL, env), env, fakeCtx())).text();
	assert.match(body, /<Stream url="wss:\/\/dialdesk-receptionist.example.workers.dev\/twilio\/stream">/);
});

test('dial-result: answered by a human hangs up after; unanswered goes to AI; caller gone hangs up', async () => {
	const env = testEnv();
	const human = await (await worker.fetch(await signed('/twilio/dial-result', { ...CALL, CallStatus: 'in-progress', DialCallStatus: 'completed', DialCallDuration: '42' }, env), env, fakeCtx())).text();
	assert.doesNotMatch(human, /<Stream/);
	assert.equal(JSON.parse(env.RECEPTIONIST_KV.store.get('call:CA100')).handledBy, 'human');

	for (const status of ['no-answer', 'busy', 'failed']) {
		const e = testEnv();
		const ai = await (await worker.fetch(await signed('/twilio/dial-result', { ...CALL, CallSid: `CA-${status}`, CallStatus: 'in-progress', DialCallStatus: status }, e), e, fakeCtx())).text();
		assert.match(ai, /<Stream url=/, status);
		assert.match(ai, /<Parameter name="ticket" value="[^"]+\.[^"]+"\/>/);
	}

	const goneEnv = testEnv();
	const gone = await (await worker.fetch(await signed('/twilio/dial-result', { ...CALL, CallStatus: 'completed', DialCallStatus: 'no-answer' }, goneEnv), goneEnv, fakeCtx())).text();
	assert.doesNotMatch(gone, /<Stream/, 'no AI session for a caller who already hung up');
	assert.equal([...goneEnv.RECEPTIONIST_KV.store.keys()].some((k) => k.startsWith('ticket:')), false);
});

test('dial-result when the budget is spent plays the message instead of opening the AI', async () => {
	const env = testEnv({ AI_ENABLED: 'false' });
	const body = await (await worker.fetch(await signed('/twilio/dial-result', { ...CALL, CallStatus: 'in-progress', DialCallStatus: 'no-answer' }, env), env, fakeCtx())).text();
	assert.doesNotMatch(body, /<Stream/);
	assert.match(body, /<Say voice="alice">/);
	assert.equal(JSON.parse(env.RECEPTIONIST_KV.store.get('call:CA100')).reason, 'disabled');
});

test('status: a missed call alerts and ingests exactly once; AI and finalized calls are skipped', async () => {
	const env = testEnv({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc-token' });
	const f = stubFetch(async () => new Response('{}'));
	try {
		await worker.fetch(await signed('/twilio/inbound', CALL, env), env, fakeCtx());
		const ctx = fakeCtx();
		const res = await worker.fetch(await signed('/twilio/status', { ...CALL, CallStatus: 'completed', CallDuration: '8' }, env), env, ctx);
		assert.equal(res.status, 204);
		await ctx.settle();
		assert.equal(f.calls.length, 2, 'alert + ingest');
		assert.match(JSON.parse(f.calls[0].init.body).content, /Missed call/);
		assert.equal(JSON.parse(f.calls[1].init.body).handledBy, 'missed');

		const again = fakeCtx();
		await worker.fetch(await signed('/twilio/status', { ...CALL, CallStatus: 'completed', CallDuration: '8' }, env), env, again);
		await again.settle();
		assert.equal(f.calls.length, 2, 'a retried status callback does not double-alert');

		const aiEnv = testEnv({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc-token' });
		await aiEnv.RECEPTIONIST_KV.put('call:CA100', JSON.stringify({ handledBy: 'ai' }));
		const c3 = fakeCtx();
		await worker.fetch(await signed('/twilio/status', { ...CALL, CallStatus: 'completed' }, aiEnv), aiEnv, c3);
		await c3.settle();
		assert.equal(f.calls.length, 2, 'AI calls are reported by the stream, not here');
	} finally {
		f.restore();
	}
});

test('status: a human-answered call ingests without an alert', async () => {
	const env = testEnv({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc-token' });
	await env.RECEPTIONIST_KV.put('call:CA100', JSON.stringify({ handledBy: 'human', dialSeconds: 42 }));
	const f = stubFetch(async () => new Response('{}'));
	try {
		const ctx = fakeCtx();
		await worker.fetch(await signed('/twilio/status', { ...CALL, CallStatus: 'completed', CallDuration: '50' }, env), env, ctx);
		await ctx.settle();
	} finally {
		f.restore();
	}
	assert.equal(f.calls.length, 1);
	const body = JSON.parse(f.calls[0].init.body);
	assert.equal(body.handledBy, 'human');
	assert.equal(body.durationSeconds, 42);
});

test('sms is forwarded to discord and never replied to', async () => {
	const env = testEnv({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc-token' });
	const f = stubFetch(async () => new Response('{}'));
	let body;
	try {
		const ctx = fakeCtx();
		const res = await worker.fetch(await signed('/twilio/sms', { From: '+12125550120', To: '+12125550100', Body: 'call me', NumMedia: '0' }, env), env, ctx);
		body = await res.text();
		await ctx.settle();
	} finally {
		f.restore();
	}
	assert.equal(body, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
	assert.match(JSON.parse(f.calls[0].init.body).content, /Text from \(212\) 555-0120:\ncall me/);
});

test('lead-context requires the bearer, validates input and skips unchanged writes', async () => {
	const env = testEnv();
	const post = (body, auth = 'Bearer shared-secret-123') =>
		worker.fetch(new Request(`${HOST}/internal/lead-context`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body }), env, fakeCtx());

	assert.equal((await post('{}', 'Bearer nope')).status, 401);
	assert.equal((await post('{}', '')).status, 401);
	assert.equal((await post('not json')).status, 400);

	const leads = [
		{ phone: '+12125550120', businessName: 'Cedar Dental, LLC', website: 'http://cedar.example' },
		{ phone: '212-555-0121', businessName: 'Bad Phone' },
		{ phone: '+12125550122' },
	];
	const first = await (await post(JSON.stringify({ leads }))).json();
	assert.deepEqual(first, { ok: true, received: 3, written: 1 });
	const second = await (await post(JSON.stringify({ leads }))).json();
	assert.equal(second.written, 0, 'unchanged lead not rewritten');
	assert.equal(JSON.parse(env.RECEPTIONIST_KV.store.get('lead:+12125550120')).businessName, 'Cedar Dental, LLC');
});

test('stream route demands a websocket upgrade; unknown paths 404; health works', async () => {
	const env = testEnv();
	assert.equal((await worker.fetch(new Request(`${HOST}/twilio/stream`), env, fakeCtx())).status, 400);
	assert.equal((await worker.fetch(new Request(`${HOST}/nope`), env, fakeCtx())).status, 404);
	assert.deepEqual(await (await worker.fetch(new Request(`${HOST}/health`), env, fakeCtx())).json(), { ok: true, aiEnabled: true });
});

test('cron flush is a single KV read when nothing is pending', async () => {
	const env = testEnv();
	let gets = 0;
	const kv = env.RECEPTIONIST_KV;
	env.RECEPTIONIST_KV = { ...kv, get: async (k) => (gets++, kv.get(k)) };
	const ctx = fakeCtx();
	await worker.scheduled({}, env, ctx);
	await ctx.settle();
	assert.equal(gets, 1);
});
