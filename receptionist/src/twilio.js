// Twilio webhook signature validation and every TwiML document this worker can emit.
//
// Money rule for the builders: the inbound path only ever <Dial>s <Client> identities
// (browser softphones), never a <Number>, has no <Redirect>, and every document ends
// in <Hangup/>. A forged or looping webhook therefore cannot place billable calls.

import { DEFAULT_WHO, endSentence } from './persona.js';

const enc = new TextEncoder();

// Twilio signs: full URL + each POST param as key+value, keys sorted. HMAC-SHA1, base64.
export async function expectedSignature(authToken, url, params) {
	const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
	entries.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1));
	const data = url + entries.map(([k, v]) => k + v).join('');
	const key = await crypto.subtle.importKey('raw', enc.encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
	return btoa(String.fromCharCode(...sig));
}

export function timingSafeEqualStr(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function validateTwilioSignature(authToken, url, params, header) {
	if (!authToken || !header) return false;
	return timingSafeEqualStr(await expectedSignature(authToken, url, params), header);
}

export function xmlEscape(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

const doc = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}<Hangup/></Response>`;

const IDENTITY = /^[a-z0-9._-]{1,64}$/;

export function parseClients(csv) {
	return (csv || '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter((s) => IDENTITY.test(s));
}

export function ringTwiml({ clients, ringSeconds, actionUrl }) {
	const seconds = Math.min(Math.max(Math.round(ringSeconds) || 10, 5), 20);
	const nouns = clients.map((c) => `<Client>${xmlEscape(c)}</Client>`).join('');
	return doc(
		`<Dial timeout="${seconds}" answerOnBridge="true" action="${xmlEscape(actionUrl)}" method="POST">${nouns}</Dial>`,
	);
}

export function aiTwiml({ streamUrl, params }) {
	const p = Object.entries(params)
		.map(([name, value]) => `<Parameter name="${xmlEscape(name)}" value="${xmlEscape(value)}"/>`)
		.join('');
	return doc(`<Connect><Stream url="${xmlEscape(streamUrl)}">${p}</Stream></Connect>`);
}

export function unavailableMessage({ companyName = DEFAULT_WHO.companyName, person = DEFAULT_WHO.person } = {}) {
	return `Thanks for calling ${endSentence(companyName)} ${person} can't pick up right now, but got your call and will call you back shortly. Goodbye.`;
}

export const UNAVAILABLE_MESSAGE = unavailableMessage();

// `who` names the workspace's company and the person who will call back.
export function unavailableTwiml(who) {
	return doc(`<Say voice="alice">${xmlEscape(unavailableMessage(who))}</Say>`);
}

export function hangupTwiml() {
	return doc('');
}

export function emptyTwiml() {
	return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}
