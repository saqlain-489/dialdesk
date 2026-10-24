import { admitAiCall, bearerOk, issueStreamTicket } from './guard.js';
import { finalizeCall, flushPending, getCallState, getLeadContext, sendAlert, setCallState, smsAlertText } from './inbound.js';
import { logError, logWarn } from './log.js';
import { DEFAULT_ORG, leadKeys, legacyOrgSlug, orgFor, personFor } from './orgs.js';
import { handlePhoneStream } from './phone.js';
import { aiTwiml, emptyTwiml, hangupTwiml, ringTwiml, unavailableTwiml, validateTwilioSignature } from './twilio.js';

const MAX_FORM_BYTES = 16 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_LEADS_PER_PUSH = 500;
const LEAD_TTL = 60 * 86400;

// Each workspace's number posts to /twilio/o/<slug>/<action>; numbers set up before
// workspaces still post to /twilio/<action>, which belongs to the legacy workspace.
const ORG_ROUTE = /^\/twilio\/o\/([a-z0-9-]{2,32})\/(inbound|dial-result|ai|status|sms)$/;
const LEGACY_ROUTE = /^\/twilio\/(inbound|dial-result|ai|status|sms)$/;
const VOICE_ACTIONS = new Set(['inbound', 'dial-result', 'ai']);

function twilioRoute(env, pathname) {
	const scoped = ORG_ROUTE.exec(pathname);
	if (scoped) {
		const org = orgFor(env, scoped[1]);
		return org && { org, action: scoped[2], base: `/twilio/o/${scoped[1]}` };
	}
	const legacy = LEGACY_ROUTE.exec(pathname);
	if (!legacy) return null;
	const org = orgFor(env, legacyOrgSlug(env));
	return org && { org, action: legacy[1], base: '/twilio' };
}

const xml = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' } });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Returns the form params, or null when the request is not a genuine Twilio webhook for
// this workspace's account: wrong signature, or a body naming another account.
async function twilioForm(request, org) {
	if (request.method !== 'POST') return null;
	const body = await request.text();
	if (body.length > MAX_FORM_BYTES) return null;
	const params = new URLSearchParams(body);
	const ok = await validateTwilioSignature(org.authToken, request.url, params, request.headers.get('x-twilio-signature'));
	if (!ok || (org.accountSid && params.get('AccountSid') !== org.accountSid)) return null;
	return Object.fromEntries(params);
}

async function whoFor(env, org, from) {
	return { companyName: org.companyName, person: personFor(org, await getLeadContext(env, from, org)) };
}

async function aiOrUnavailable(env, url, p, { org }) {
	const admission = await admitAiCall(env, p.From);
	if (!admission.ok) {
		await setCallState(env, p.CallSid, { handledBy: 'missed', reason: admission.reason }).catch(() => {});
		return unavailableTwiml(await whoFor(env, org, p.From));
	}
	try {
		const ticket = await issueStreamTicket(p.CallSid, env.TICKET_SECRET, Date.now(), org.slug);
		return aiTwiml({ streamUrl: `wss://${url.host}/twilio/stream`, params: { ticket, from: p.From || '', to: p.To || '' } });
	} catch (err) {
		logError('ticket.issue', err);
		return unavailableTwiml(await whoFor(env, org, p.From));
	}
}

async function onInbound(env, url, p, route) {
	await setCallState(env, p.CallSid, { from: p.From, to: p.To, startedAt: new Date().toISOString() }).catch((err) =>
		logWarn('call.state', err),
	);
	const { clients } = route.org;
	if (!clients.length) return aiOrUnavailable(env, url, p, route);
	return ringTwiml({
		clients,
		ringSeconds: Number(env.INBOUND_RING_SECONDS),
		actionUrl: `https://${url.host}${route.base}/dial-result`,
	});
}

async function onDialResult(env, url, p, route) {
	if (p.DialCallStatus === 'completed' || p.DialCallStatus === 'answered') {
		await setCallState(env, p.CallSid, { handledBy: 'human', dialSeconds: Number(p.DialCallDuration) || 0 }).catch(() => {});
		return hangupTwiml();
	}
	// Caller hung up while the browser was ringing: /twilio/status reports it as missed.
	if (p.CallStatus === 'completed' || p.CallStatus === 'canceled') return hangupTwiml();
	return aiOrUnavailable(env, url, p, route);
}

const FINAL_STATUSES = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

async function onStatus(env, p, { org }) {
	if (!FINAL_STATUSES.has(p.CallStatus)) return;
	const state = (await getCallState(env, p.CallSid)) || {};
	if (state.finalized || state.handledBy === 'ai') return;
	const lead = await getLeadContext(env, p.From, org);
	const duration = Number(p.CallDuration) || 0;
	const endedAt = new Date();
	const human = state.handledBy === 'human';
	await finalizeCall(
		env,
		{
			org: org.ingestSlug,
			callSid: p.CallSid,
			from: p.From,
			to: p.To,
			handledBy: human ? 'human' : 'missed',
			reason: human ? null : state.reason || 'caller_hung_up_ringing',
			leadBusiness: lead?.businessName ?? null,
			startedAt: state.startedAt || new Date(endedAt - duration * 1000).toISOString(),
			endedAt: endedAt.toISOString(),
			durationSeconds: human ? state.dialSeconds || duration : duration,
		},
		{ notify: !human, org },
	);
}

async function onSms(env, p, { org }) {
	const lead = await getLeadContext(env, p.From, org);
	await sendAlert(env, smsAlertText({ from: p.From, body: p.Body, numMedia: p.NumMedia, leadBusiness: lead?.businessName }), org);
}

const cleanCaller = (name) =>
	typeof name === 'string' ? name.replace(/[^\p{L} '-]/gu, '').trim().slice(0, 40) || null : null;

async function onLeadContext(request, env) {
	if (request.method !== 'POST') return json(405, { error: 'POST only' });
	if (!bearerOk(request, env.INBOUND_SHARED_SECRET)) return json(401, { error: 'unauthorized' });
	const text = await request.text();
	if (text.length > MAX_JSON_BYTES) return json(413, { error: 'too large' });
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		return json(400, { error: 'invalid json' });
	}
	// Pushes before workspaces carried no `org`; they belong to the legacy workspace. Without
	// ORG_CONFIG this worker serves one number, so any workspace's push lands there.
	const org = env.ORG_CONFIG ? orgFor(env, body?.org ?? legacyOrgSlug(env)) : orgFor(env, DEFAULT_ORG);
	if (!org) return json(400, { error: 'unknown workspace' });
	const leads = Array.isArray(body?.leads) ? body.leads.slice(0, MAX_LEADS_PER_PUSH) : [];
	let written = 0;
	for (const l of leads) {
		if (!/^\+1\d{10}$/.test(l?.phone || '') || typeof l.businessName !== 'string') continue;
		const callerName = cleanCaller(l.callerName);
		const value = JSON.stringify({
			businessName: l.businessName.slice(0, 120),
			website: typeof l.website === 'string' ? l.website.slice(0, 200) : null,
			...(callerName ? { callerName } : {}),
		});
		const key = leadKeys(org, l.phone)[0];
		// Free KV allows 1,000 writes a day, so unchanged leads are skipped.
		if ((await env.RECEPTIONIST_KV.get(key)) === value) continue;
		await env.RECEPTIONIST_KV.put(key, value, { expirationTtl: LEAD_TTL });
		written++;
	}
	return json(200, { ok: true, received: leads.length, written });
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		try {
			if (url.pathname === '/health') return json(200, { ok: true, aiEnabled: env.AI_ENABLED === 'true' });

			if (url.pathname === '/twilio/stream') {
				if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 400 });
				return handlePhoneStream(request, env, ctx);
			}

			if (url.pathname === '/internal/lead-context') return await onLeadContext(request, env);

			if (url.pathname.startsWith('/twilio/')) {
				const route = twilioRoute(env, url.pathname);
				// An unknown workspace gets the same answer as a forged signature.
				const p = route && (await twilioForm(request, route.org));
				if (!p) return new Response('Forbidden', { status: 403 });
				switch (route.action) {
					case 'inbound':
						return xml(await onInbound(env, url, p, route));
					case 'dial-result':
						return xml(await onDialResult(env, url, p, route));
					case 'ai':
						return xml(await aiOrUnavailable(env, url, p, route));
					case 'status':
						ctx.waitUntil(onStatus(env, p, route).catch((err) => logError('status', err)));
						return new Response(null, { status: 204 });
					case 'sms':
						ctx.waitUntil(onSms(env, p, route).catch((err) => logError('sms', err)));
						return xml(emptyTwiml());
				}
			}
			return new Response('Not found', { status: 404 });
		} catch (err) {
			logError('fetch', err, { path: url.pathname });
			// A voice webhook that errors should still answer the caller politely.
			const action = ORG_ROUTE.exec(url.pathname)?.[2] ?? LEGACY_ROUTE.exec(url.pathname)?.[1];
			if (VOICE_ACTIONS.has(action)) {
				const org = (() => {
					try {
						return twilioRoute(env, url.pathname)?.org;
					} catch {
						return null;
					}
				})();
				return xml(unavailableTwiml(org ? { companyName: org.companyName, person: org.ownerName } : undefined));
			}
			return new Response('Server error', { status: 500 });
		}
	},

	async scheduled(_event, env, ctx) {
		ctx.waitUntil(flushPending(env).catch((err) => logError('cron.flush', err)));
	},
};
