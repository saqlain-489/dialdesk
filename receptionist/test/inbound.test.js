import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertText, finalizeCall, flushPending, ingestPayload, sendAlert } from '../src/inbound.js';
import { stubFetch, testEnv } from './helpers.js';

const RECORD = {
	callSid: 'CA1',
	from: '+12125550120',
	to: '+12125550100',
	handledBy: 'ai',
	reason: 'completed',
	leadBusiness: 'Harbor Pet Grooming',
	startedAt: '2026-09-30T20:00:00.000Z',
	endedAt: '2026-09-30T20:02:00.000Z',
	durationSeconds: 120.4,
	transcript: { lines: [{ speaker: 'lead', start: 1, text: 'You called me earlier.' }, { speaker: 'ai', start: 3, text: 'Thanks!' }] },
	aiSummary: { name: 'Dana', bestTime: 'tomorrow 10am', flags: ['wants_meeting'] },
};

test('ingest payload is the fixed shape dialdesk expects', () => {
	const p = ingestPayload(RECORD);
	assert.deepEqual(Object.keys(p).sort(), ['aiSummary', 'callSid', 'durationSeconds', 'endedAt', 'from', 'handledBy', 'reason', 'startedAt', 'to', 'transcript'].sort());
	assert.equal(p.durationSeconds, 120);
	assert.equal(ingestPayload({ ...RECORD, transcript: { lines: [] } }).transcript, null);
});

test('discord alert text for an AI call and a missed call', () => {
	const ai = alertText(RECORD);
	assert.match(ai, /Ava took a call: Harbor Pet Grooming · \(212\) 555-0120/);
	assert.match(ai, /Call back: tomorrow 10am/);
	assert.match(ai, /They said: "You called me earlier\."/);
	const missed = alertText({ callSid: 'CA2', from: '+12125550120', handledBy: 'missed', reason: 'daily_budget' });
	assert.match(missed, /Missed call/);
	assert.match(missed, /AI minutes used up/);
});

test('finalize sends discord alert then ingest, with bearer auth', async () => {
	const env = testEnv({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc-token' });
	const f = stubFetch(async () => new Response('{}', { status: 200 }));
	try {
		await finalizeCall(env, RECORD);
	} finally {
		f.restore();
	}
	assert.equal(f.calls.length, 2);
	assert.equal(f.calls[0].url, 'https://discord.com/api/webhooks/123/abc-token?wait=true');
	assert.deepEqual(JSON.parse(f.calls[0].init.body).allowed_mentions, { parse: [] });
	assert.equal(f.calls[1].url, 'https://dialdesk.example.com/api/inbound/ingest');
	assert.equal(f.calls[1].init.headers.authorization, 'Bearer shared-secret-123');
	assert.equal(env.RECEPTIONIST_KV.store.get('pending:index'), undefined, 'nothing queued on success');
	assert.equal(JSON.parse(env.RECEPTIONIST_KV.store.get('call:CA1')).finalized, true);
});

test('a failed ingest is queued and the cron redelivers it once the app server is up', async () => {
	const env = testEnv();
	let serverUp = false;
	const f = stubFetch(async (url) => {
		if (url.includes('/api/inbound/ingest')) return new Response('', { status: serverUp ? 200 : 502 });
		return new Response('{}');
	});
	try {
		await finalizeCall(env, RECORD, { notify: false });
		assert.deepEqual(JSON.parse(env.RECEPTIONIST_KV.store.get('pending:index')), ['CA1']);

		assert.deepEqual(await flushPending(env), { delivered: 0, remaining: 1 }, 'still asleep: kept');
		serverUp = true;
		assert.deepEqual(await flushPending(env), { delivered: 1, remaining: 0 });
		assert.equal(env.RECEPTIONIST_KV.store.has('pending:CA1'), false);
		const before = f.calls.length;
		assert.deepEqual(await flushPending(env), { delivered: 0, remaining: 0 });
		assert.equal(f.calls.length, before, 'empty queue makes no network calls');
	} finally {
		f.restore();
	}
});

test('discord alert is skipped cleanly when not configured', async () => {
	const env = testEnv();
	const f = stubFetch(async () => new Response('{}'));
	try {
		await finalizeCall(env, RECORD);
	} finally {
		f.restore();
	}
	assert.equal(f.calls.filter((c) => c.url.includes('discord')).length, 0);
});

test('alerts only ever go to a real Discord webhook, trimmed to its limit', async () => {
	const f = stubFetch(async () => new Response(null, { status: 204 }));
	try {
		assert.equal(await sendAlert(testEnv({ DISCORD_WEBHOOK_URL: 'https://evil.example/api/webhooks/1/x' }), 'hi'), false);
		assert.equal(await sendAlert(testEnv({ DISCORD_WEBHOOK_URL: 'http://discord.com/api/webhooks/1/x' }), 'hi'), false);
		assert.equal(f.calls.length, 0, 'nothing sent to a non-Discord URL');
		assert.equal(await sendAlert(testEnv({ DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc-token' }), 'x'.repeat(5000)), true);
		assert.equal(JSON.parse(f.calls[0].init.body).content.length, 1901);
	} finally {
		f.restore();
	}
});
