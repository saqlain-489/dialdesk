// Validates the Voice Live key with the worker's exact session.update, never sends response.create (no audio, ~$0).
import { readFileSync } from 'node:fs';
import { buildInstructions, TOOLS } from '../src/persona.js';
import { buildAzureUrl, phoneSessionUpdate } from '../src/realtime.js';

const env = Object.fromEntries(
	readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
		.split('\n')
		.filter((l) => /^[A-Z_]+=/.test(l))
		.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const vars = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const tomlVar = (name) => vars.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];

const model = tomlVar('AZURE_VOICELIVE_MODEL');
const voice = tomlVar('AZURE_VOICELIVE_VOICE');
const apiVersion = tomlVar('AZURE_VOICELIVE_API_VERSION');
if (!env.AZURE_VOICELIVE_ENDPOINT || !env.AZURE_VOICELIVE_API_KEY) throw new Error('endpoint/key missing in .dev.vars');

const url = buildAzureUrl(env.AZURE_VOICELIVE_ENDPOINT, apiVersion, model).replace(/^http/, 'ws');
console.log(`host=${new URL(url).host} model=${model} voice=${voice} api-version=${apiVersion}`);

const ws = new WebSocket(url, { headers: { 'api-key': env.AZURE_VOICELIVE_API_KEY } });
const t0 = Date.now();
let ok = false;
const errors = [];
const done = (code) => {
	try { ws.close(); } catch { /* closed */ }
	console.log(ok && !errors.length ? 'RESULT: PASS' : 'RESULT: FAIL');
	process.exit(code ?? (ok && !errors.length ? 0 : 1));
};
const timer = setTimeout(() => {
	console.log('timeout waiting for session.updated');
	done(1);
}, 15000);

ws.addEventListener('open', () => {
	console.log(`open +${Date.now() - t0}ms`);
	ws.send(JSON.stringify(phoneSessionUpdate({ model, voice, instructions: buildInstructions(null), tools: TOOLS })));
});
ws.addEventListener('message', (evt) => {
	const msg = JSON.parse(evt.data);
	if (msg.type === 'error') {
		errors.push(msg.error);
		console.log('error event:', JSON.stringify(msg.error));
		return;
	}
	if (msg.type === 'session.created') console.log(`session.created +${Date.now() - t0}ms`);
	if (msg.type === 'session.updated') {
		ok = true;
		const s = msg.session;
		console.log(`session.updated +${Date.now() - t0}ms`);
		console.log(
			JSON.stringify({
				model: s.model,
				voice: s.voice,
				input_audio_format: s.input_audio_format,
				output_audio_format: s.output_audio_format,
				turn_detection: s.turn_detection?.type,
				transcription: s.input_audio_transcription,
				noise: s.input_audio_noise_reduction?.type,
				echo: s.input_audio_echo_cancellation?.type,
				tools: s.tools?.map((t) => t.name),
				instructionsChars: s.instructions?.length,
			}),
		);
		// Linger briefly so a late validation error still surfaces before we close.
		clearTimeout(timer);
		setTimeout(() => done(), 1500);
	}
});
ws.addEventListener('error', (e) => {
	console.log('socket error:', e.message ?? e.type);
	done(1);
});
ws.addEventListener('close', (e) => {
	if (!ok) {
		console.log(`closed early code=${e.code} reason=${e.reason}`);
		done(1);
	}
});
