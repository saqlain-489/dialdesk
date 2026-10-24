// Plays Twilio against a deployed worker: a scripted caller (Azure TTS, mu-law) talks to Ava, no phone leg.
// Usage: node scripts/simulate-call.mjs <outDir> <workerBaseUrl> <workspaceNumber>. Costs ~2 min of Voice Live
// (paid); posts a real alert and app row. Signs as the single-number workspace with TWILIO_AUTH_TOKEN from .dev.vars.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { expectedSignature } from '../src/twilio.js';

const outDir = process.argv[2];
const base = (process.argv[3] || '').replace(/\/$/, '');
const TO = process.argv[4];
if (!outDir || !base || !TO) throw new Error('usage: simulate-call.mjs <outDir> <workerBaseUrl> <workspaceNumber>');
mkdirSync(outDir, { recursive: true });

const readVars = (path) =>
	Object.fromEntries(
		readFileSync(path, 'utf8')
			.split('\n')
			.filter((l) => /^[A-Z_]+=/.test(l))
			.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
	);
const dev = readVars(new URL('../.dev.vars', import.meta.url));

// Fictional 555-01XX number: the app lists it as a test call.
const FROM = '+12125550199';
const CALLER_LINES = [
	"Hi, this is Sam with Test Plumbing. I think somebody from your company called me earlier.",
	'Oh okay. Sure, tomorrow at ten in the morning works for me.',
	"Yeah, this number's fine.",
	'Sure. It is sam at example dot com.',
	"Yep, that's right.",
	"Okay, sounds good. Thanks, bye.",
];
const FRAME = 160;
const SILENCE = 0xff;
const MAX_MS = 4 * 60_000;

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(7);
const log = (...a) => console.log(ts(), ...a);

async function tts(text) {
	const region = 'eastus2';
	const ssml = `<speak version="1.0" xml:lang="en-US"><voice name="en-US-GuyNeural">${text.replace(/&/g, '&amp;')}</voice></speak>`;
	const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
		method: 'POST',
		headers: {
			'Ocp-Apim-Subscription-Key': dev.AZURE_VOICELIVE_API_KEY,
			'Content-Type': 'application/ssml+xml',
			'X-Microsoft-OutputFormat': 'raw-8khz-8bit-mono-mulaw',
			'User-Agent': 'dialdesk-sim',
		},
		body: ssml,
	});
	if (!res.ok) throw new Error(`tts ${res.status} ${(await res.text()).slice(0, 200)}`);
	return Buffer.from(await res.arrayBuffer());
}

function ulawToPcm(u) {
	u = ~u & 0xff;
	const sign = u & 0x80;
	const exponent = (u >> 4) & 0x07;
	const sample = ((((u & 0x0f) << 3) + 0x84) << exponent) - 0x84;
	return sign ? -sample : sample;
}

function wav(samples) {
	const buf = Buffer.alloc(44 + samples.length * 2);
	buf.write('RIFF', 0);
	buf.writeUInt32LE(36 + samples.length * 2, 4);
	buf.write('WAVEfmt ', 8);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(8000, 24);
	buf.writeUInt32LE(16000, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36);
	buf.writeUInt32LE(samples.length * 2, 40);
	samples.forEach((s, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, s)), 44 + i * 2));
	return buf;
}

log('synthesizing caller lines');
const lines = [];
for (const text of CALLER_LINES) lines.push({ text, audio: await tts(text) });
log(`caller audio ready: ${lines.map((l) => (l.audio.length / 8000).toFixed(1) + 's').join(', ')}`);

// All-zero prefix marks a simulated call; dialdesk ingest requires CA + 32 hex.
const callSid = `CA00000000${randomBytes(12).toString('hex')}`;
const params = new URLSearchParams({ CallSid: callSid, From: FROM, To: TO, CallStatus: 'in-progress' });
const aiUrl = `${base}/twilio/ai`;
const twiml = await (
	await fetch(aiUrl, {
		method: 'POST',
		headers: { 'x-twilio-signature': await expectedSignature(dev.TWILIO_AUTH_TOKEN, aiUrl, params), 'content-type': 'application/x-www-form-urlencoded' },
		body: params,
	})
).text();
const ticket = twiml.match(/name="ticket" value="([^"]+)"/)?.[1];
if (!ticket) throw new Error(`no ticket, TwiML was: ${twiml.slice(0, 300)}`);
log(`callSid=${callSid} ticket issued`);

const streamSid = `MZ${randomBytes(16).toString('hex')}`;
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/twilio/stream`);
const mix = [];
let avaQueue = [];
let avaQueued = 0;
let avaPlayed = 0;
const pendingMarks = [];
let lastAvaMedia = 0;
let firstAvaAt = null;
let avaTurns = 0;
let avaSpeaking = false;
let lineIdx = 0;
let speaking = null;
let gapUntil = 0;
let frames = 0;
let seq = 1;
let closed = false;
let started = 0;

const send = (obj) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));

function tick() {
	const due = Math.floor((Date.now() - started) / 20);
	while (frames < due && !closed) {
		frames++;
		let callerFrame = Buffer.alloc(FRAME, SILENCE);
		if (speaking) {
			const chunk = speaking.audio.subarray(speaking.pos, speaking.pos + FRAME);
			chunk.copy(callerFrame);
			speaking.pos += FRAME;
			if (speaking.pos >= speaking.audio.length) {
				log(`caller done line ${lineIdx}`);
				speaking = null;
			}
		}
		send({ event: 'media', sequenceNumber: String(++seq), streamSid, media: { track: 'inbound', chunk: String(frames), timestamp: String(frames * 20), payload: callerFrame.toString('base64') } });

		const avaFrame = Buffer.alloc(FRAME, SILENCE);
		let took = 0;
		while (took < FRAME && avaQueue.length) {
			const head = avaQueue[0];
			const n = Math.min(FRAME - took, head.length);
			head.copy(avaFrame, took, 0, n);
			took += n;
			if (n === head.length) avaQueue.shift();
			else avaQueue[0] = head.subarray(n);
		}
		avaPlayed += took;
		while (pendingMarks.length && avaPlayed >= pendingMarks[0].at) {
			const m = pendingMarks.shift();
			log(`echo mark ${m.name}`);
			send({ event: 'mark', sequenceNumber: String(++seq), streamSid, mark: { name: m.name } });
		}
		for (let i = 0; i < FRAME; i++) mix.push(ulawToPcm(callerFrame[i]) + ulawToPcm(avaFrame[i]));
	}

	const now = Date.now();
	const avaIdle = avaQueue.length === 0 && now - lastAvaMedia > 1200;
	if (avaSpeaking && avaIdle) {
		avaSpeaking = false;
		log(`ava finished turn ${avaTurns}`);
		gapUntil = now + 600;
	}
	if (!speaking && !avaSpeaking && avaTurns > lineIdx && now >= gapUntil && lineIdx < lines.length) {
		speaking = { ...lines[lineIdx], pos: 0 };
		lineIdx++;
		log(`caller line ${lineIdx}: "${speaking.text}"`);
	}
	if (now - t0 > MAX_MS) {
		log('max duration, sending stop');
		send({ event: 'stop', sequenceNumber: String(++seq), streamSid, stop: { callSid } });
		ws.close();
	}
}

let timer;
ws.addEventListener('open', () => {
	log('stream socket open');
	send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
	send({
		event: 'start',
		sequenceNumber: '1',
		streamSid,
		start: { streamSid, callSid, accountSid: 'ACsim', tracks: ['inbound'], customParameters: { ticket, from: FROM, to: TO }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } },
	});
	started = Date.now();
	timer = setInterval(tick, 10);
});
ws.addEventListener('message', (evt) => {
	const msg = JSON.parse(evt.data);
	if (msg.event === 'media') {
		const b = Buffer.from(msg.media.payload, 'base64');
		avaQueue.push(b);
		avaQueued += b.length;
		lastAvaMedia = Date.now();
		if (!firstAvaAt) {
			firstAvaAt = Date.now();
			log(`first Ava audio (${firstAvaAt - started} ms after start)`);
		}
		if (!avaSpeaking) {
			avaSpeaking = true;
			avaTurns++;
			log(`ava speaking, turn ${avaTurns}`);
		}
	} else if (msg.event === 'clear') {
		log('clear (barge-in)');
		avaPlayed += avaQueue.reduce((n, b) => n + b.length, 0);
		avaQueue = [];
	} else if (msg.event === 'mark') {
		log(`mark ${msg.mark?.name} queued`);
		pendingMarks.push({ name: msg.mark?.name, at: avaQueued });
	} else {
		log(`worker event ${msg.event}`);
	}
});
const done = (why) => {
	if (closed) return;
	closed = true;
	clearInterval(timer);
	log(`stream closed: ${why}`);
	const path = `${outDir}/${callSid}.wav`;
	writeFileSync(path, wav(mix));
	console.log(JSON.stringify({ callSid, seconds: Math.round(mix.length / 8000), avaTurns, callerLinesSpoken: lineIdx, wav: path }));
	setTimeout(() => process.exit(0), 100);
};
ws.addEventListener('close', (e) => done(`code=${e.code} reason=${e.reason}`));
ws.addEventListener('error', (e) => done(`error ${e.message ?? e.type}`));
