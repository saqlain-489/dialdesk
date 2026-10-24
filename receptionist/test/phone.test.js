import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayKey, issueStreamTicket } from '../src/guard.js';
import { runPhoneSession } from '../src/phone.js';
import { stubFetch, testEnv } from './helpers.js';

class FakeSocket {
	constructor() {
		this.sent = [];
		this.listeners = {};
		this.closed = false;
	}
	accept() {}
	addEventListener(type, fn) {
		(this.listeners[type] ||= []).push(fn);
	}
	send(data) {
		if (this.closed) throw new Error('closed');
		this.sent.push(JSON.parse(data));
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.emit('close');
	}
	emit(type, data) {
		for (const fn of this.listeners[type] || []) fn(data === undefined ? {} : { data: typeof data === 'string' ? data : JSON.stringify(data) });
	}
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 3000) => {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error('timed out waiting');
		await tick(5);
	}
};

function harness(envOverrides = {}, { azureStatus = 101 } = {}) {
	const env = testEnv({ TWILIO_ACCOUNT_SID: 'AC1', ...envOverrides });
	const twilio = new FakeSocket();
	const azure = new FakeSocket();
	const f = stubFetch(async (url, init) => {
		if (url.includes('/voice-live/realtime')) {
			if (azureStatus !== 101) return { status: azureStatus, text: async () => 'nope', webSocket: null };
			assert.equal(init.headers['api-key'], 'test-key');
			return { status: 101, webSocket: azure, text: async () => '' };
		}
		return new Response('{}', { status: 200 });
	});
	return { env, twilio, azure, f };
}

async function start(h, callSid = 'CA1', { ticket } = {}) {
	const t = ticket ?? (await issueStreamTicket(callSid, h.env.TICKET_SECRET));
	const done = runPhoneSession(h.twilio, h.env);
	h.twilio.emit('message', { event: 'connected' });
	h.twilio.emit('message', {
		event: 'start',
		start: { streamSid: 'MZ1', callSid, customParameters: { ticket: t, from: '+12125550120', to: '+12125550100' } },
	});
	return done;
}

const azureCalls = (f) => f.calls.filter((c) => c.url.includes('/voice-live/realtime'));

test('a full AI call: greeting, audio both ways, tools, goodbye, clean hangup, billing and ingest', async () => {
	const h = harness();
	await h.env.RECEPTIONIST_KV.put('lead:+12125550120', JSON.stringify({ businessName: 'Harbor Pet Grooming' }));
	try {
		const done = start(h);
		await until(() => h.azure.sent.length >= 2);
		const [update, greeting] = h.azure.sent;
		assert.equal(update.type, 'session.update');
		assert.equal(update.session.input_audio_format, 'g711_ulaw');
		assert.match(update.session.instructions, /Harbor Pet Grooming/);
		assert.match(greeting.response.pre_generated_assistant_message.content[0].text, /AI assistant at Acme Co\. .*Who am I speaking with\?$/);
		assert.ok(h.env.RECEPTIONIST_KV.store.get('live').includes('CA1'), 'slot taken');

		h.twilio.emit('message', { event: 'media', media: { track: 'inbound', payload: 'AAAA' } });
		assert.deepEqual({ type: h.azure.sent.at(-1).type, audio: h.azure.sent.at(-1).audio }, { type: 'input_audio_buffer.append', audio: 'AAAA' });

		h.azure.emit('message', { type: 'response.created' });
		h.azure.emit('message', { type: 'response.audio.delta', delta: 'BBBB' });
		assert.deepEqual(h.twilio.sent.at(-1), { event: 'media', streamSid: 'MZ1', media: { payload: 'BBBB' } });

		h.azure.emit('message', { type: 'input_audio_buffer.speech_started' });
		assert.deepEqual(h.twilio.sent.at(-1), { event: 'clear', streamSid: 'MZ1' }, 'barge-in clears Twilio audio');
		assert.equal(h.azure.sent.at(-1).type, 'response.cancel');
		h.azure.emit('message', { type: 'response.done' });

		h.azure.emit('message', { type: 'conversation.item.input_audio_transcription.completed', transcript: "It's Dana, call me at ten." });
		h.azure.emit('message', { type: 'response.created' });
		h.azure.emit('message', { type: 'response.function_call_arguments.done', name: 'capture_message', call_id: 'c1', arguments: '{"name":"Dana","best_time":"10am"}' });
		assert.equal(h.azure.sent.at(-1).type, 'response.create', 'tool output is followed by a new response');
		h.azure.emit('message', { type: 'response.done' });

		h.azure.emit('message', { type: 'response.created' });
		h.azure.emit('message', { type: 'response.audio_transcript.done', transcript: 'Thanks Dana, bye!' });
		h.azure.emit('message', { type: 'response.function_call_arguments.done', name: 'end_call', call_id: 'c2', arguments: '{}' });
		assert.ok(!h.twilio.sent.some((m) => m.event === 'mark'), 'no hangup before the goodbye finishes');
		const clears = () => h.twilio.sent.filter((m) => m.event === 'clear').length;
		const before = clears();
		h.azure.emit('message', { type: 'input_audio_buffer.speech_started' });
		assert.equal(clears(), before, 'goodbye is not interruptible');
		h.azure.emit('message', { type: 'response.done' });
		assert.deepEqual(h.twilio.sent.at(-1), { event: 'mark', streamSid: 'MZ1', mark: { name: 'bye' } });

		h.twilio.emit('message', { event: 'mark', mark: { name: 'bye' } });
		await done;

		assert.equal(h.azure.closed, true, 'Azure closed with the call');
		assert.equal(h.twilio.closed, true);
		assert.equal(JSON.parse(h.env.RECEPTIONIST_KV.store.get('live')).CA1, undefined, 'slot released');
		assert.ok(Number(h.env.RECEPTIONIST_KV.store.get(`budget:${dayKey()}`)) >= 1, 'minutes charged');
		const ingest = h.f.calls.find((c) => c.url.endsWith('/api/inbound/ingest'));
		const body = JSON.parse(ingest.init.body);
		assert.equal(body.handledBy, 'ai');
		assert.equal(body.reason, 'completed');
		assert.deepEqual(body.aiSummary, { name: 'Dana', bestTime: '10am', flags: [] });
		assert.deepEqual(body.transcript.lines.map((l) => l.speaker), ['lead', 'ai']);
	} finally {
		h.f.restore();
	}
});

const sentTypes = (h, type) => h.azure.sent.filter((m) => m.type === type);
const marks = (h, name) => h.twilio.sent.filter((m) => m.event === 'mark' && m.mark.name === name);

async function openCall(h) {
	const done = start(h);
	await until(() => h.azure.sent.length >= 2);
	h.azure.emit('message', { type: 'response.created' });
	h.azure.emit('message', { type: 'response.audio.delta', delta: 'BBBB' });
	h.azure.emit('message', { type: 'response.done' });
	return done;
}

test('caller talks over the greeting: audio cleared, instructions get the note, base restored after the reply', async () => {
	const h = harness();
	try {
		const done = openCall(h);
		await until(() => marks(h, 'greeting').length === 1);
		const base = h.azure.sent[0].session.instructions;

		h.azure.emit('message', { type: 'input_audio_buffer.speech_started' });
		const note = sentTypes(h, 'session.update').at(-1);
		assert.match(note.session.instructions, /talking over your greeting/);
		assert.ok(note.session.instructions.startsWith(base));
		assert.equal(h.twilio.sent.at(-1).event, 'clear');

		h.twilio.emit('message', { event: 'mark', mark: { name: 'greeting' } });
		h.azure.emit('message', { type: 'input_audio_buffer.speech_started' });
		assert.equal(sentTypes(h, 'session.update').length, 2, 'only the first interruption adds the note');

		h.azure.emit('message', { type: 'response.created' });
		h.azure.emit('message', { type: 'response.done' });
		assert.equal(sentTypes(h, 'session.update').at(-1).session.instructions, base, 'base instructions restored');

		h.twilio.emit('message', { event: 'stop' });
		await done;
	} finally {
		h.f.restore();
	}
});

test('a greeting that played to the end is not treated as interrupted', async () => {
	const h = harness();
	try {
		const done = openCall(h);
		await until(() => marks(h, 'greeting').length === 1);
		h.twilio.emit('message', { event: 'mark', mark: { name: 'greeting' } });
		h.azure.emit('message', { type: 'input_audio_buffer.speech_started' });
		assert.equal(sentTypes(h, 'session.update').length, 1, 'no note after a heard greeting');
		h.twilio.emit('message', { event: 'stop' });
		await done;
	} finally {
		h.f.restore();
	}
});

test('noise cuts the greeting and the model stays quiet: Ava still speaks after 2.5s', async () => {
	const h = harness();
	try {
		const done = openCall(h);
		await until(() => marks(h, 'greeting').length === 1);
		h.azure.emit('message', { type: 'input_audio_buffer.speech_started' });
		h.azure.emit('message', { type: 'input_audio_buffer.speech_stopped' });
		const before = sentTypes(h, 'response.create').length;
		await tick(2400);
		assert.equal(sentTypes(h, 'response.create').length, before, 'not before the wait is up');
		await until(() => sentTypes(h, 'response.create').length === before + 1, 1000);
		assert.match(sentTypes(h, 'response.create').at(-1).response.instructions, /didn't catch/);
		h.twilio.emit('message', { event: 'stop' });
		await done;
	} finally {
		h.f.restore();
	}
});

test('no nudge when the model answers by itself', async () => {
	const h = harness();
	try {
		const done = openCall(h);
		await until(() => marks(h, 'greeting').length === 1);
		h.azure.emit('message', { type: 'input_audio_buffer.speech_started' });
		h.azure.emit('message', { type: 'input_audio_buffer.speech_stopped' });
		const before = sentTypes(h, 'response.create').length;
		h.azure.emit('message', { type: 'response.created' });
		await tick(2700);
		assert.equal(sentTypes(h, 'response.create').length, before);
		h.twilio.emit('message', { event: 'stop' });
		await done;
	} finally {
		h.f.restore();
	}
});

test('slow KV: caller audio is never sent to Azure before session.update', async () => {
	const h = harness();
	const kv = h.env.RECEPTIONIST_KV;
	const slow = (fn) => async (...args) => {
		if (azureCalls(h.f).length) await tick(40);
		return fn(...args);
	};
	h.env.RECEPTIONIST_KV = { ...kv, get: slow(kv.get), put: slow(kv.put), delete: slow(kv.delete) };
	try {
		const done = start(h);
		await until(() => azureCalls(h.f).length === 1);
		while (h.azure.sent.length === 0) {
			h.twilio.emit('message', { event: 'media', media: { track: 'inbound', payload: 'AAAA' } });
			await tick(5);
		}
		assert.equal(h.azure.sent[0].type, 'session.update', 'Voice Live kills the session after 5 messages that are not session.update');
		h.twilio.emit('message', { event: 'media', media: { track: 'inbound', payload: 'AAAA' } });
		assert.equal(h.azure.sent.at(-1).type, 'input_audio_buffer.append', 'audio flows once configured');
		h.twilio.emit('message', { event: 'stop' });
		await done;
	} finally {
		h.f.restore();
	}
});

test('Azure errors that arrive before the main listener are still logged', async () => {
	const h = harness();
	const kv = h.env.RECEPTIONIST_KV;
	h.env.RECEPTIONIST_KV = { ...kv, get: async (...a) => (azureCalls(h.f).length && (await tick(30)), kv.get(...a)) };
	const warned = [];
	const original = console.warn;
	console.warn = (line) => warned.push(line);
	try {
		const done = start(h);
		await until(() => azureCalls(h.f).length === 1);
		await tick(1);
		h.azure.emit('message', { type: 'error', error: { code: 'max_config_attempts_exceeded', message: 'Session configuration failed' } });
		await until(() => h.azure.sent.length >= 2);
		h.twilio.emit('message', { event: 'stop' });
		await done;
		assert.ok(warned.some((l) => l.includes('max_config_attempts_exceeded')), 'early error logged');
	} finally {
		console.warn = original;
		h.f.restore();
	}
});

test('a bad or replayed ticket never opens Azure', async () => {
	const h = harness();
	try {
		await start(h, 'CA1', { ticket: 'forged.ticket' });
		assert.equal(azureCalls(h.f).length, 0);
		assert.equal(h.twilio.closed, true);

		const t =await issueStreamTicket('CA9', h.env.TICKET_SECRET);
		const h3 = harness();
		h3.env.RECEPTIONIST_KV = h.env.RECEPTIONIST_KV;
		const first = start(h3, 'CA9', { ticket: t });
		await until(() => h3.azure.sent.length >= 2);
		h3.twilio.emit('message', { event: 'stop' });
		await first;
		h3.f.restore();

		const h4 = harness();
		h4.env.RECEPTIONIST_KV = h.env.RECEPTIONIST_KV;
		await start(h4, 'CA9', { ticket: t });
		assert.equal(azureCalls(h4.f).length, 0, 'replay refused');
		h4.f.restore();
	} finally {
		h.f.restore();
	}
});

test('no start event within the timeout closes without touching Azure', { timeout: 15000 }, async () => {
	const h = harness();
	try {
		await runPhoneSession(h.twilio, h.env);
		assert.equal(azureCalls(h.f).length, 0);
		assert.equal(h.twilio.closed, true);
	} finally {
		h.f.restore();
	}
});

test('spent budget at stream start: no Azure, call is redirected to the message', async () => {
	const h = harness({ PHONE_MAX_DAILY_SECONDS: '10' });
	await h.env.RECEPTIONIST_KV.put(`budget:${dayKey()}`, '10');
	try {
		await start(h);
		assert.equal(azureCalls(h.f).length, 0);
		const redirect = h.f.calls.find((c) => c.url.includes('api.twilio.com'));
		assert.match(redirect.url, /\/Accounts\/AC1\/Calls\/CA1\.json$/);
		assert.match(new URLSearchParams(redirect.init.body).get('Twiml'), /<Say/);
		assert.equal(JSON.parse(h.env.RECEPTIONIST_KV.store.get('call:CA1')).reason, 'daily_budget');
	} finally {
		h.f.restore();
	}
});

test('Azure outage: caller gets the message, logged as missed, nothing charged', async () => {
	const h = harness({}, { azureStatus: 500 });
	try {
		await start(h);
		assert.ok(h.f.calls.some((c) => c.url.includes('api.twilio.com')));
		assert.equal(JSON.parse(h.env.RECEPTIONIST_KV.store.get('call:CA1')).reason, 'ai_unavailable');
		assert.equal(h.env.RECEPTIONIST_KV.store.get(`budget:${dayKey()}`), undefined);
	} finally {
		h.f.restore();
	}
});

test('caller hangs up mid-call: Azure closes and the call is still recorded', async () => {
	const h = harness();
	try {
		const done = start(h);
		await until(() => h.azure.sent.length >= 2);
		h.twilio.emit('message', { event: 'stop' });
		await done;
		assert.equal(h.azure.closed, true);
		const body = JSON.parse(h.f.calls.find((c) => c.url.endsWith('/api/inbound/ingest')).init.body);
		assert.equal(body.reason, 'caller_hung_up');
	} finally {
		h.f.restore();
	}
});

test('Azure drops mid-call: the phone side closes too', async () => {
	const h = harness();
	try {
		const done = start(h);
		await until(() => h.azure.sent.length >= 2);
		h.azure.close();
		await done;
		assert.equal(h.twilio.closed, true);
	} finally {
		h.f.restore();
	}
});

test('silence cap wraps up politely, waiting for the current response first', async () => {
	const h = harness({ PHONE_SILENCE_SECONDS: '0.5' });
	try {
		const done = start(h);
		await until(() => h.azure.sent.length >= 2);
		h.azure.emit('message', { type: 'response.created' });
		await tick(1600);
		assert.ok(!h.azure.sent.some((m) => m.response?.instructions), 'no wrap-up while the AI is mid-sentence');
		h.azure.emit('message', { type: 'response.done' });
		const wrap = h.azure.sent.at(-1);
		assert.match(wrap.response.instructions, /end the call now/);
		assert.equal(marks(h, 'bye').length, 0);

		h.azure.emit('message', { type: 'response.created' });
		h.azure.emit('message', { type: 'response.done' });
		assert.deepEqual(h.twilio.sent.at(-1).mark, { name: 'bye' });
		h.twilio.emit('message', { event: 'mark', mark: { name: 'bye' } });
		await done;
		assert.equal(h.azure.closed, true);
	} finally {
		h.f.restore();
	}
});

test('hard time cap force-closes even if the AI never says goodbye', { timeout: 10000 }, async () => {
	const h = harness({ PHONE_MAX_SECONDS: '0.2', PHONE_SILENCE_SECONDS: '999' });
	const realSetTimeout = globalThis.setTimeout;
	// Shrink the 20s wrap grace period so the test runs fast; the 1s tick is untouched.
	globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 20_000 ? 50 : ms, ...a);
	try {
		const done = start(h);
		await until(() => h.azure.sent.length >= 2);
		await done;
		assert.equal(h.azure.closed, true);
		assert.equal(h.twilio.closed, true);
		const body = JSON.parse(h.f.calls.find((c) => c.url.endsWith('/api/inbound/ingest')).init.body);
		assert.equal(body.reason, 'forced');
	} finally {
		globalThis.setTimeout = realSetTimeout;
		h.f.restore();
	}
});
