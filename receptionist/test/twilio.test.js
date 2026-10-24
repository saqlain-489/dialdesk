import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	aiTwiml,
	expectedSignature,
	hangupTwiml,
	parseClients,
	ringTwiml,
	unavailableTwiml,
	validateTwilioSignature,
	xmlEscape,
} from '../src/twilio.js';

// The request from Twilio's documented signature example, numbers included.
const PARAMS = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };

// Vectors produced by the official twilio SDK (getExpectedTwilioSignature); the first is Twilio's documented example request.
test('signature matches the official Twilio SDK', async () => {
	assert.equal(await expectedSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', PARAMS), '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
	assert.equal(
		await expectedSignature('12345', 'https://dialdesk-receptionist.example.workers.dev/twilio/inbound', PARAMS),
		'bkAHAKmk9H2n9/HCEBcZoT0P9GU=',
	);
});

test('signature validation accepts genuine and rejects forged, missing or tampered', async () => {
	const url = 'https://dialdesk-receptionist.example.workers.dev/twilio/inbound';
	assert.equal(await validateTwilioSignature('12345', url, PARAMS, 'bkAHAKmk9H2n9/HCEBcZoT0P9GU='), true);
	assert.equal(await validateTwilioSignature('12345', url, PARAMS, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='), false);
	assert.equal(await validateTwilioSignature('12345', url, PARAMS, null), false);
	assert.equal(await validateTwilioSignature('', url, PARAMS, 'bkAHAKmk9H2n9/HCEBcZoT0P9GU='), false);
	assert.equal(await validateTwilioSignature('12345', url, { ...PARAMS, From: '+12125550199' }, 'bkAHAKmk9H2n9/HCEBcZoT0P9GU='), false);
	assert.equal(await validateTwilioSignature('12345', `${url}x`, PARAMS, 'bkAHAKmk9H2n9/HCEBcZoT0P9GU='), false);
});

test('URLSearchParams and object params sign identically', async () => {
	const url = 'https://x.dev/twilio/inbound';
	assert.equal(await expectedSignature('t', url, new URLSearchParams(PARAMS)), await expectedSignature('t', url, PARAMS));
});

test('xmlEscape neutralises markup', () => {
	assert.equal(xmlEscape(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
});

test('parseClients keeps only safe identities', () => {
	assert.deepEqual(parseClients(' Jordan.Acme , sam.acme,<Number>+1,, '), ['jordan.acme', 'sam.acme']);
	assert.deepEqual(parseClients(''), []);
});

const ALL = [
	ringTwiml({ clients: ['jordan.acme'], ringSeconds: 10, actionUrl: 'https://x.dev/twilio/dial-result' }),
	aiTwiml({ streamUrl: 'wss://x.dev/twilio/stream', params: { ticket: 'a.b', from: '+12125550120', to: '+12125550100' } }),
	unavailableTwiml(),
	hangupTwiml(),
];

test('no TwiML can dial a phone number or loop, and every document hangs up', () => {
	for (const doc of ALL) {
		assert.ok(!doc.includes('<Number'), doc);
		assert.ok(!doc.includes('<Redirect'), doc);
		assert.ok(!doc.includes('<Enqueue'), doc);
		assert.ok(doc.endsWith('<Hangup/></Response>'), doc);
	}
});

test('ring TwiML dials the browser client with a clamped timeout and the action URL', () => {
	const doc = ringTwiml({ clients: ['jordan.acme', 'sam.acme'], ringSeconds: 999, actionUrl: 'https://x.dev/twilio/dial-result' });
	assert.match(doc, /<Dial timeout="20" answerOnBridge="true" action="https:\/\/x.dev\/twilio\/dial-result" method="POST">/);
	assert.match(doc, /<Client>jordan.acme<\/Client><Client>sam.acme<\/Client>/);
	assert.match(ringTwiml({ clients: ['a'], ringSeconds: 1, actionUrl: 'u' }), /timeout="5"/);
});

test('AI TwiML streams to the worker and escapes parameters', () => {
	const doc = aiTwiml({ streamUrl: 'wss://x.dev/twilio/stream', params: { ticket: 'a"b', from: '+1' } });
	assert.match(doc, /<Connect><Stream url="wss:\/\/x.dev\/twilio\/stream"><Parameter name="ticket" value="a&quot;b"\/>/);
});
