// Where a finished inbound call goes: KV record, Discord alert, dialdesk ingest.
// A free-tier app server sleeps, so a failed ingest is queued and the cron redelivers it.

import { logInfo, logWarn } from './log.js';
import { leadKeys } from './orgs.js';

const WEEK = 7 * 86400;
const MAX_PENDING = 200;
const FLUSH_BATCH = 10;

export async function getCallState(env, sid) {
	const raw = await env.RECEPTIONIST_KV.get(`call:${sid}`);
	return raw ? JSON.parse(raw) : null;
}

export async function setCallState(env, sid, patch) {
	const current = (await getCallState(env, sid)) || {};
	const next = { ...current, ...patch };
	await env.RECEPTIONIST_KV.put(`call:${sid}`, JSON.stringify(next), { expirationTtl: WEEK });
	return next;
}

// Lead context is per workspace: the same business may have been dialed from another number.
export async function getLeadContext(env, phone, org) {
	if (!/^\+1\d{10}$/.test(phone || '')) return null;
	try {
		for (const key of org ? leadKeys(org, phone) : [`lead:${phone}`]) {
			const raw = await env.RECEPTIONIST_KV.get(key);
			if (raw) return JSON.parse(raw);
		}
		return null;
	} catch {
		return null;
	}
}

function formatPhone(e164) {
	const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
	return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || 'unknown number';
}

const REASON_TEXT = {
	caller_hung_up_ringing: 'hung up while ringing',
	disabled: 'AI switched off',
	not_configured: 'AI not configured',
	daily_budget: "today's AI minutes used up",
	number_cap: 'this number hit its AI limit for today',
	busy: 'AI lines busy',
	kv_error: 'budget check failed',
	ai_unavailable: 'AI could not connect',
};

export function alertText(record) {
	const who = record.leadBusiness ? `${record.leadBusiness} · ${formatPhone(record.from)}` : formatPhone(record.from);
	if (record.handledBy === 'missed') {
		const why = REASON_TEXT[record.reason] || record.reason || 'no answer';
		return `☎️ Missed call: ${who}\nReason: ${why}\nCall them back.`;
	}
	const s = record.aiSummary || {};
	const lines = [`🤖 Ava took a call: ${who}`];
	if (s.name) lines.push(`Name: ${s.name}`);
	if (s.business && s.business !== record.leadBusiness) lines.push(`Business: ${s.business}`);
	if (s.reason) lines.push(`Reason: ${s.reason}`);
	if (s.bestTime) lines.push(`Call back: ${s.bestTime}`);
	if (s.callbackNumber) lines.push(`Number: ${s.callbackNumber}`);
	if (s.email) lines.push(`Email: ${s.email}`);
	if (s.notes) lines.push(`Notes: ${s.notes}`);
	if (s.flags?.length) lines.push(`Flags: ${s.flags.join(', ')}`);
	lines.push(`Length: ${Math.round(record.durationSeconds || 0)}s`);
	const said = (record.transcript?.lines || []).filter((l) => l.speaker === 'lead').map((l) => l.text).join(' ');
	if (said) lines.push(`\nThey said: "${said.slice(0, 600)}${said.length > 600 ? '…' : ''}"`);
	return lines.join('\n');
}

export function smsAlertText({ from, body, numMedia, leadBusiness }) {
	const who = leadBusiness ? `${leadBusiness} · ${formatPhone(from)}` : formatPhone(from);
	const media = Number(numMedia) > 0 ? `\n(+${numMedia} attachment${Number(numMedia) > 1 ? 's' : ''})` : '';
	return `💬 Text from ${who}:\n${String(body || '').slice(0, 1500)}${media}`;
}

const DISCORD_WEBHOOK = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const DISCORD_MAX_CHARS = 1900;

// Each workspace can send to its own channel, so a team reading theirs never sees another's calls.
export async function sendAlert(env, text, org) {
	const url = org?.discordWebhookUrl || env.DISCORD_WEBHOOK_URL;
	if (!url || !DISCORD_WEBHOOK.test(url)) return false;
	const labelled = org?.ingestSlug ? `[${org.ingestSlug}] ${text}` : text;
	const content = labelled.length > DISCORD_MAX_CHARS ? `${labelled.slice(0, DISCORD_MAX_CHARS)}…` : labelled;
	try {
		// ?wait=true makes Discord answer with a status we can check instead of fire-and-forget.
		const res = await fetch(`${url}?wait=true`, {
			method: 'POST',
			// Workers send no User-Agent by default, and Discord's API rejects requests without one.
			headers: { 'content-type': 'application/json', 'user-agent': 'DiscordBot (https://example.com/dialdesk, 1.0)' },
			// SMS bodies and transcripts are caller-supplied: never let them ping @everyone.
			body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
			signal: AbortSignal.timeout(8000),
		});
		// Never log the URL: the webhook token is part of it.
		if (!res.ok) logWarn('alert', new Error(`status ${res.status}`), { body: (await res.text().catch(() => '')).slice(0, 200) });
		else logInfo('alert.sent', { status: res.status });
		return res.ok;
	} catch (err) {
		logWarn('alert', err);
		return false;
	}
}

export function ingestPayload(record) {
	return {
		...(record.org ? { org: record.org } : {}),
		callSid: record.callSid,
		from: record.from,
		to: record.to ?? null,
		handledBy: record.handledBy,
		reason: record.reason ?? null,
		startedAt: record.startedAt,
		endedAt: record.endedAt ?? null,
		durationSeconds: Math.round(record.durationSeconds || 0),
		transcript: record.transcript?.lines?.length ? record.transcript : null,
		aiSummary: record.aiSummary ?? null,
	};
}

// 'delivered', 'retry' (app server asleep or erroring) or 'rejected': a 4xx means dialdesk will
// never accept this record (e.g. no workspace owns the number), so retrying is pointless.
export async function deliverIngest(env, record) {
	if (!env.DIALDESK_URL || !env.INBOUND_SHARED_SECRET) return 'retry';
	try {
		const res = await fetch(`${env.DIALDESK_URL.replace(/\/$/, '')}/api/inbound/ingest`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${env.INBOUND_SHARED_SECRET}` },
			body: JSON.stringify(ingestPayload(record)),
			// The alert (8s) + this must fit the 30s a Worker gets after its response/socket closes.
			signal: AbortSignal.timeout(15000),
		});
		if (res.ok) return 'delivered';
		return res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 ? 'rejected' : 'retry';
	} catch {
		return 'retry';
	}
}

async function reportRejected(env, record) {
	logWarn('ingest.rejected', new Error('dialdesk refused the call record'), { callSid: record.callSid, to: record.to });
	await sendAlert(env, `⚠️ dialdesk refused the record of a call to ${formatPhone(record.to)} from ${formatPhone(record.from)}. It was not saved; check the workspace's number.`);
}

async function readIndex(env) {
	const raw = await env.RECEPTIONIST_KV.get('pending:index');
	return raw ? JSON.parse(raw) : [];
}

export async function queuePending(env, record) {
	const index = await readIndex(env);
	if (!index.includes(record.callSid)) index.push(record.callSid);
	await env.RECEPTIONIST_KV.put(`pending:${record.callSid}`, JSON.stringify(record), { expirationTtl: WEEK });
	await env.RECEPTIONIST_KV.put('pending:index', JSON.stringify(index.slice(-MAX_PENDING)), { expirationTtl: WEEK });
}

// Cron: one `get` when nothing is queued, so the 5-minute schedule costs almost nothing.
export async function flushPending(env) {
	const index = await readIndex(env);
	if (!index.length) return { delivered: 0, remaining: 0 };
	const keep = [];
	let delivered = 0;
	for (const [i, sid] of index.entries()) {
		if (i >= FLUSH_BATCH) {
			keep.push(sid);
			continue;
		}
		const raw = await env.RECEPTIONIST_KV.get(`pending:${sid}`);
		if (!raw) continue;
		const record = JSON.parse(raw);
		const outcome = await deliverIngest(env, record);
		if (outcome === 'retry') {
			// App server still asleep or down: stop hammering it this round.
			keep.push(...index.slice(i));
			break;
		}
		// A permanent refusal is dropped, never retried: left in place it would block the
		// whole queue behind it for a week.
		if (outcome === 'delivered') delivered++;
		else await reportRejected(env, record);
		await env.RECEPTIONIST_KV.delete(`pending:${sid}`);
	}
	await env.RECEPTIONIST_KV.put('pending:index', JSON.stringify(keep), { expirationTtl: WEEK });
	if (delivered) logInfo('ingest.flushed', { delivered, remaining: keep.length });
	return { delivered, remaining: keep.length };
}

// Alert first so it is instant, then the durable ingest.
export async function finalizeCall(env, record, { notify = true, org } = {}) {
	await setCallState(env, record.callSid, { handledBy: record.handledBy, finalized: true }).catch((err) =>
		logWarn('call.state', err),
	);
	if (notify) await sendAlert(env, alertText(record), org);
	const outcome = await deliverIngest(env, record);
	if (outcome === 'retry') await queuePending(env, record).catch((err) => logWarn('ingest.queue', err));
	else if (outcome === 'rejected') await reportRejected(env, record);
}
