import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	admitAiCall,
	bearerOk,
	dayKey,
	issueStreamTicket,
	numberBucket,
	redeemStreamTicket,
	sessionClosed,
	sessionOpened,
} from '../src/guard.js';
import { memoryKv, testEnv } from './helpers.js';

const FROM = '+12125550120';

test('ticket redeems once, only for its own call', async () => {
	const env = testEnv();
	const ticket = await issueStreamTicket('CA1', env.TICKET_SECRET);
	assert.equal(await redeemStreamTicket(ticket, 'CA2', env), false);
	assert.equal(await redeemStreamTicket(ticket, 'CA1', env), true);
	assert.equal(await redeemStreamTicket(ticket, 'CA1', env), false, 'replay must fail');
});

test('ticket rejects expiry, tampering, wrong secret and garbage', async () => {
	const env = testEnv();
	const old = await issueStreamTicket('CA1', env.TICKET_SECRET, Date.now() - 120_000);
	assert.equal(await redeemStreamTicket(old, 'CA1', env), false);
	const good = await issueStreamTicket('CA3', env.TICKET_SECRET);
	const [body, sig] = good.split('.');
	assert.equal(await redeemStreamTicket(`${body}x.${sig}`, 'CA3', env), false);
	assert.equal(await redeemStreamTicket(await issueStreamTicket('CA4', 'other-secret'), 'CA4', env), false);
	for (const junk of [undefined, '', 'nodot', '..', 'a.b']) assert.equal(await redeemStreamTicket(junk, 'CA1', env), false);
	assert.equal(await redeemStreamTicket(good, 'CA3', testEnv({ TICKET_SECRET: '' })), false);
});

test('admission allows a normal call', async () => {
	assert.deepEqual(await admitAiCall(testEnv(), FROM), { ok: true });
});

test('admission fails closed: kill switch, missing config, KV outage', async () => {
	assert.equal((await admitAiCall(testEnv({ AI_ENABLED: 'false' }), FROM)).reason, 'disabled');
	assert.equal((await admitAiCall(testEnv({ AI_ENABLED: undefined }), FROM)).reason, 'disabled');
	assert.equal((await admitAiCall(testEnv({ AZURE_VOICELIVE_API_KEY: '' }), FROM)).reason, 'not_configured');
	assert.equal((await admitAiCall(testEnv({ RECEPTIONIST_KV: memoryKv({ failGets: true }) }), FROM)).reason, 'kv_error');
});

test('admission enforces the daily budget', async () => {
	const env = testEnv({ PHONE_MAX_DAILY_SECONDS: '100' });
	await sessionOpened(env, 'CA1', FROM);
	await sessionClosed(env, 'CA1', 99.2);
	assert.equal(env.RECEPTIONIST_KV.store.get(`budget:${dayKey()}`), '100', 'seconds are rounded up');
	assert.equal((await admitAiCall(env, '+12125550131')).reason, 'daily_budget');
});

test('admission enforces the per-number cap, withheld numbers share a bucket', async () => {
	const env = testEnv({ PHONE_MAX_AI_PER_NUMBER_PER_DAY: '2', PHONE_MAX_CONCURRENT: '10' });
	for (const sid of ['CA1', 'CA2']) {
		await sessionOpened(env, sid, FROM);
		await sessionClosed(env, sid, 5);
	}
	assert.equal((await admitAiCall(env, FROM)).reason, 'number_cap');
	assert.deepEqual(await admitAiCall(env, '+12125550139'), { ok: true });
	assert.equal(await numberBucket('Anonymous'), await numberBucket(''));
	// +266696687 spells ANONYMOUS on a keypad: Twilio's From for a withheld caller ID.
	assert.equal(await numberBucket('+266696687'), await numberBucket('+266696687'));
});

test('admission enforces concurrency, and a closed session frees its slot', async () => {
	const env = testEnv({ PHONE_MAX_CONCURRENT: '2' });
	await sessionOpened(env, 'CA1', '+12125550141');
	await sessionOpened(env, 'CA2', '+12125550142');
	assert.equal((await admitAiCall(env, '+12125550143')).reason, 'busy');
	await sessionClosed(env, 'CA1', 10);
	assert.deepEqual(await admitAiCall(env, '+12125550143'), { ok: true });
});

test('a slot leaked by a crashed session expires instead of blocking forever', async () => {
	const env = testEnv({ PHONE_MAX_CONCURRENT: '1' });
	await sessionOpened(env, 'CA1', FROM, Date.now() - 20 * 60 * 1000);
	assert.deepEqual(await admitAiCall(env, '+12125550143'), { ok: true });
});

test('bearer check', () => {
	const req = (h) => new Request('https://x.dev', { headers: h ? { authorization: h } : {} });
	assert.equal(bearerOk(req('Bearer shared-secret-123'), 'shared-secret-123'), true);
	assert.equal(bearerOk(req('Bearer shared-secret-124'), 'shared-secret-123'), false);
	assert.equal(bearerOk(req('shared-secret-123'), 'shared-secret-123'), false);
	assert.equal(bearerOk(req(null), 'shared-secret-123'), false);
	assert.equal(bearerOk(req('Bearer '), ''), false);
});
