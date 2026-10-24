// Spend controls for the phone AI. Every Azure minute is gated here.
//
// KV is eventually consistent, so these caps are soft; the hard ceiling is the per-call
// timer in phone.js. Every check FAILS CLOSED: if KV errors, the caller gets the spoken
// "we'll call you back" message instead of an AI session nobody can account for.

const enc = new TextEncoder();
const TICKET_TTL_SECONDS = 60;
// A live slot older than this is a session that died without releasing it.
const LIVE_SLOT_MAX_MS = 15 * 60 * 1000;

async function hmacKey(secret) {
	return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function num(v, fallback) {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function phoneLimits(env) {
	return {
		maxSessionSeconds: num(env.PHONE_MAX_SECONDS, 300),
		silenceSeconds: num(env.PHONE_SILENCE_SECONDS, 30),
		maxDailySeconds: num(env.PHONE_MAX_DAILY_SECONDS, 3600),
		maxPerNumberPerDay: num(env.PHONE_MAX_AI_PER_NUMBER_PER_DAY, 3),
		maxConcurrent: num(env.PHONE_MAX_CONCURRENT, 2),
	};
}

export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

async function sha256Hex(text) {
	const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Withheld / anonymous callers all share one bucket so they cannot dodge the per-number cap.
export async function numberBucket(from) {
	const normalized = /^\+\d{8,15}$/.test(from || '') ? from : 'withheld';
	return (await sha256Hex(normalized)).slice(0, 16);
}

// `org` rides inside the signed ticket, so the media stream can't be pointed at another
// workspace's lead context or Twilio account by editing a <Parameter>.
export async function issueStreamTicket(callSid, secret, now = Date.now(), org = undefined) {
	if (!secret) throw new Error('TICKET_SECRET missing');
	const exp = Math.floor(now / 1000) + TICKET_TTL_SECONDS;
	const body = b64url(enc.encode(JSON.stringify({ sid: callSid, exp, ...(org ? { org } : {}) })));
	const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body))));
	return `${body}.${sig}`;
}

// Signature, expiry, bound to this exact call, then burned so it cannot open a second session.
// Returns the ticket's claims ({ sid, exp, org? }) or null.
export async function redeemStreamTicketClaims(ticket, callSid, env, now = Date.now()) {
	if (!ticket || !callSid || !env.TICKET_SECRET) return null;
	const [body, sig] = String(ticket).split('.');
	if (!body || !sig) return null;
	try {
		const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.TICKET_SECRET), fromB64url(sig), enc.encode(body));
		if (!ok) return null;
		const claims = JSON.parse(new TextDecoder().decode(fromB64url(body)));
		if (claims.sid !== callSid) return null;
		if (claims.exp < Math.floor(now / 1000)) return null;
		const burnKey = `ticket:${callSid}`;
		if (await env.RECEPTIONIST_KV.get(burnKey)) return null;
		await env.RECEPTIONIST_KV.put(burnKey, '1', { expirationTtl: 3600 });
		return claims;
	} catch {
		return null;
	}
}

export async function redeemStreamTicket(ticket, callSid, env, now = Date.now()) {
	return Boolean(await redeemStreamTicketClaims(ticket, callSid, env, now));
}

async function readLive(env, now) {
	const raw = await env.RECEPTIONIST_KV.get('live');
	const map = raw ? JSON.parse(raw) : {};
	for (const [sid, startedAt] of Object.entries(map)) {
		if (now - startedAt > LIVE_SLOT_MAX_MS) delete map[sid];
	}
	return map;
}

// Returns { ok: true } or { ok: false, reason }. Read-only: nothing is charged until a stream starts.
export async function admitAiCall(env, from, now = Date.now()) {
	if (env.AI_ENABLED !== 'true') return { ok: false, reason: 'disabled' };
	if (!env.AZURE_VOICELIVE_ENDPOINT || !env.AZURE_VOICELIVE_API_KEY || !env.TICKET_SECRET) {
		return { ok: false, reason: 'not_configured' };
	}
	const L = phoneLimits(env);
	try {
		const bucket = await numberBucket(from);
		const [used, perNumber, live] = await Promise.all([
			env.RECEPTIONIST_KV.get(`budget:${dayKey(new Date(now))}`),
			env.RECEPTIONIST_KV.get(`num:${bucket}:${dayKey(new Date(now))}`),
			readLive(env, now),
		]);
		if ((Number(used) || 0) >= L.maxDailySeconds) return { ok: false, reason: 'daily_budget' };
		if ((Number(perNumber) || 0) >= L.maxPerNumberPerDay) return { ok: false, reason: 'number_cap' };
		if (Object.keys(live).length >= L.maxConcurrent) return { ok: false, reason: 'busy' };
		return { ok: true };
	} catch {
		return { ok: false, reason: 'kv_error' };
	}
}

export async function sessionOpened(env, callSid, from, now = Date.now()) {
	const bucket = await numberBucket(from);
	const numKey = `num:${bucket}:${dayKey(new Date(now))}`;
	const [live, perNumber] = await Promise.all([readLive(env, now), env.RECEPTIONIST_KV.get(numKey)]);
	live[callSid] = now;
	await Promise.all([
		env.RECEPTIONIST_KV.put('live', JSON.stringify(live), { expirationTtl: 3600 }),
		env.RECEPTIONIST_KV.put(numKey, String((Number(perNumber) || 0) + 1), { expirationTtl: 2 * 86400 }),
	]);
}

// One write pair at close: free the slot and charge the day's budget.
export async function sessionClosed(env, callSid, seconds, now = Date.now()) {
	const budgetKey = `budget:${dayKey(new Date(now))}`;
	const [live, used] = await Promise.all([readLive(env, now), env.RECEPTIONIST_KV.get(budgetKey)]);
	delete live[callSid];
	await Promise.all([
		env.RECEPTIONIST_KV.put('live', JSON.stringify(live), { expirationTtl: 3600 }),
		env.RECEPTIONIST_KV.put(budgetKey, String((Number(used) || 0) + Math.ceil(seconds)), { expirationTtl: 2 * 86400 }),
	]);
}

export function bearerOk(request, secret) {
	const header = request.headers.get('authorization') || '';
	const token = header.startsWith('Bearer ') ? header.slice(7) : '';
	if (!secret || !token || token.length !== secret.length) return false;
	let diff = 0;
	for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
	return diff === 0;
}
