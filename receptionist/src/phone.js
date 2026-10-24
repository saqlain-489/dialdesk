// Twilio Media Stream <-> Azure Voice Live bridge for one inbound call.
//
// Cost safety, in order of authority:
//   1. no Azure socket opens until the stream ticket (bound to this CallSid) is redeemed
//   2. the admission gate is re-checked at stream start (two calls can pass /dial-result together)
//   3. hard in-memory timer: wrap-up at PHONE_MAX_SECONDS, force-close 20s later regardless
//   4. either side closing closes the other, so Azure never outlives the phone call

import { admitAiCall, phoneLimits, redeemStreamTicketClaims, sessionClosed, sessionOpened } from './guard.js';
import { finalizeCall, getLeadContext, setCallState } from './inbound.js';
import { logError, logInfo, logWarn } from './log.js';
import { legacyOrgSlug, orgFor, personFor } from './orgs.js';
import { buildInstructions, greetingFor, interruptedNote, MISSED_AUDIO_NOTE, TOOLS, wrapUpInstruction } from './persona.js';
import { azureSettings, connectAzure, eventId, greetingEvent, phoneSessionUpdate, safeSend } from './realtime.js';
import { unavailableTwiml } from './twilio.js';

const START_TIMEOUT_MS = 10_000;
const FORCE_CLOSE_AFTER_WRAP_MS = 20_000;
const BYE_MARK = 'bye';
const GREETING_MARK = 'greeting';
const MISSED_AUDIO_NUDGE_MS = 2500;

const MESSAGE_FIELDS = {
	name: 'name',
	business: 'business',
	callback_number: 'callbackNumber',
	best_time: 'bestTime',
	reason: 'reason',
	email: 'email',
	notes: 'notes',
};

export function mergeMessage(summary, args) {
	const next = { ...summary };
	for (const [from, to] of Object.entries(MESSAGE_FIELDS)) {
		const v = args?.[from];
		if (typeof v === 'string' && v.trim()) next[to] = v.trim().slice(0, 500);
	}
	return next;
}

export function twilioMediaToAzure(payload) {
	return { type: 'input_audio_buffer.append', audio: payload, event_id: eventId() };
}

export function azureDeltaToTwilio(streamSid, delta) {
	return { event: 'media', streamSid, media: { payload: delta } };
}

// Swap a live call onto the spoken "we'll call you back" message, using the Twilio account
// of the workspace the call came in on. Modifies the existing call only; never creates one.
async function redirectToUnavailable(org, callSid, who) {
	if (!org?.accountSid || !org.authToken) return;
	try {
		const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${org.accountSid}/Calls/${callSid}.json`, {
			method: 'POST',
			headers: {
				authorization: `Basic ${btoa(`${org.accountSid}:${org.authToken}`)}`,
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({ Twiml: unavailableTwiml(who) }),
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) logWarn('phone.redirect', new Error(`status ${res.status}`));
	} catch (err) {
		logWarn('phone.redirect', err);
	}
}

export function handlePhoneStream(request, env, ctx) {
	const pair = new WebSocketPair();
	const [client, server] = [pair[0], pair[1]];
	ctx.waitUntil(runPhoneSession(server, env));
	return new Response(null, { status: 101, webSocket: client });
}

export async function runPhoneSession(twilio, env) {
	twilio.accept();
	const L = phoneLimits(env);

	let streamSid = null;
	let callSid = null;
	let from = null;
	let to = null;
	let lead = null;
	let org = null;
	let who;
	let upstream = null;
	let opened = false;
	// Voice Live kills a session after 5 messages that aren't session.update, so no audio goes up before it.
	let configured = false;
	let startedAt = null;
	let lastActivity = Date.now();
	let activeResponse = false;
	// none -> pending (waiting for the current response to finish) -> sent -> speaking
	let wrapState = 'none';
	let endRequested = false;
	let byeSent = false;
	// playing -> heard (the greeting mark came back) or interrupted (caller spoke first)
	let greeting = 'playing';
	let greetingMarkSent = false;
	let baseInstructions = '';
	let noteActive = false;
	let noteReplyStarted = false;
	let nudgeTimer = null;
	let closed = false;
	let forceTimer = null;
	let tick = null;
	let summary = {};
	const stats = { azureEvents: 0, firstAzureEvent: null, audioOut: 0, mediaIn: 0, sendFails: 0 };
	const flags = new Set();
	const lines = [];
	let closeResolve;
	const closedPromise = new Promise((r) => (closeResolve = r));

	const since = () => (startedAt ? Math.round((Date.now() - startedAt) / 100) / 10 : 0);

	const finish = async (reason) => {
		if (closed) return;
		closed = true;
		clearInterval(tick);
		clearTimeout(forceTimer);
		clearTimeout(startTimer);
		clearTimeout(nudgeTimer);
		try { upstream?.close(); } catch { /* already closed */ }
		try { twilio.close(1000, reason); } catch { /* already closed */ }

		if (!opened) {
			closeResolve();
			return;
		}
		const seconds = (Date.now() - startedAt) / 1000;
		logInfo('phone.end', { callSid, reason, seconds: Math.round(seconds), ...stats });
		try {
			await sessionClosed(env, callSid, seconds);
		} catch (err) {
			logWarn('phone.kv_close', err);
		}
		try {
			await finalizeCall(env, {
				org: org?.ingestSlug,
				callSid,
				from,
				to,
				handledBy: 'ai',
				reason,
				leadBusiness: lead?.businessName ?? null,
				startedAt: new Date(startedAt).toISOString(),
				endedAt: new Date().toISOString(),
				durationSeconds: seconds,
				transcript: { lines },
				aiSummary: { ...summary, flags: [...flags] },
			}, { org });
		} catch (err) {
			logError('phone.finalize', err, { callSid });
		}
		closeResolve();
	};

	const startTimer = setTimeout(() => finish('no_start'), START_TIMEOUT_MS);

	const sendBye = () => {
		if (byeSent || !streamSid) return;
		byeSent = true;
		// Twilio echoes a mark only after all audio queued before it has played,
		// so the goodbye is never cut off.
		safeSend(twilio, { event: 'mark', streamSid, mark: { name: BYE_MARK } });
	};

	const sendWrap = () => {
		wrapState = 'sent';
		safeSend(upstream, { type: 'response.create', event_id: eventId(), response: { instructions: wrapUpInstruction(who) } });
	};

	// Never cancel mid-sentence to wrap up: a cancelled response also emits response.done,
	// which would fire the hangup mark before the goodbye is spoken.
	const wrapUp = () => {
		if (wrapState !== 'none' || endRequested || closed) return;
		if (!forceTimer) forceTimer = setTimeout(() => finish('forced'), FORCE_CLOSE_AFTER_WRAP_MS);
		if (activeResponse) wrapState = 'pending';
		else sendWrap();
	};

	const startAi = async (start) => {
		clearTimeout(startTimer);
		streamSid = start.streamSid;
		callSid = start.callSid;
		const params = start.customParameters || {};
		from = typeof params.from === 'string' ? params.from : null;
		to = typeof params.to === 'string' ? params.to : null;

		// The workspace comes from the signed ticket, never from an unsigned stream parameter.
		const claims = await redeemStreamTicketClaims(params.ticket, callSid, env);
		org = claims && orgFor(env, claims.org ?? legacyOrgSlug(env));
		if (!org) {
			logWarn('phone.ticket', new Error('rejected'), { callSid });
			return finish('bad_ticket');
		}
		lead = await getLeadContext(env, from, org);
		who = { companyName: org.companyName, person: personFor(org, lead) };

		const admission = await admitAiCall(env, from);
		if (!admission.ok) {
			await setCallState(env, callSid, { handledBy: 'missed', reason: admission.reason }).catch(() => {});
			await redirectToUnavailable(org, callSid, who);
			return finish('denied');
		}

		try {
			upstream = await connectAzure(env);
			// Attached before the KV awaits below: errors in that window would otherwise be lost.
			upstream.addEventListener('message', (evt) => {
				const text = typeof evt.data === 'string' ? evt.data : '';
				if (stats.azureEvents++ === 0) stats.firstAzureEvent = text.match(/"type":"([^"]+)"/)?.[1] ?? 'binary';
				if (!configured && text.includes('"type":"error"')) {
					let code = 'unknown';
					try { code = JSON.parse(text).error?.code ?? code; } catch { /* keep unknown */ }
					logWarn('phone.azure_error', new Error(code), { callSid, early: true });
				}
			});
		} catch (err) {
			logError('phone.azure', err, { callSid, detail: err.detail });
			await setCallState(env, callSid, { handledBy: 'missed', reason: 'ai_unavailable' }).catch(() => {});
			await redirectToUnavailable(org, callSid, who);
			return finish('azure_failed');
		}
		if (closed) {
			try { upstream.close(); } catch { /* ignore */ }
			return;
		}

		opened = true;
		startedAt = Date.now();
		lastActivity = startedAt;
		await Promise.all([
			sessionOpened(env, callSid, from).catch((err) => logWarn('phone.kv_open', err)),
			setCallState(env, callSid, { handledBy: 'ai', startedAt: new Date(startedAt).toISOString() }).catch((err) =>
				logWarn('phone.state', err),
			),
		]);
		// The caller can hang up during the awaits above; finish() already cleaned up.
		if (closed) return;

		tick = setInterval(() => {
			const elapsed = (Date.now() - startedAt) / 1000;
			if (elapsed >= L.maxSessionSeconds + FORCE_CLOSE_AFTER_WRAP_MS / 1000) return finish('time_limit');
			if (elapsed >= L.maxSessionSeconds) return wrapUp();
			if ((Date.now() - lastActivity) / 1000 > L.silenceSeconds) return wrapUp();
		}, 1000);

		upstream.addEventListener('message', onAzureMessage);
		upstream.addEventListener('close', (evt) => {
			logInfo('phone.upstream_close', { callSid, code: evt.code, reason: String(evt.reason || '').slice(0, 120) });
			finish('upstream_closed');
		});
		upstream.addEventListener('error', (evt) => {
			logWarn('phone.upstream_error', new Error(evt.message || 'error'), { callSid });
			finish('upstream_error');
		});

		const { model, voice } = azureSettings(env);
		if (!safeSend(upstream, phoneSessionUpdate({ model, voice, instructions: (baseInstructions = buildInstructions(lead, who)), tools: TOOLS }))) {
			stats.sendFails++;
			logWarn('phone.send', new Error('session.update send failed'), { callSid, readyState: upstream.readyState });
		}
		configured = true;
		safeSend(upstream, greetingEvent(greetingFor(lead, who)));
	};

	const onToolCall = (msg) => {
		let args = {};
		try { args = JSON.parse(msg.arguments || '{}'); } catch { /* keep {} */ }
		if (msg.name === 'capture_message') summary = mergeMessage(summary, args);
		if (msg.name === 'flag_call' && typeof args.tag === 'string') flags.add(args.tag.slice(0, 40));

		if (msg.name === 'end_call') {
			endRequested = true;
			safeSend(upstream, {
				type: 'conversation.item.create',
				event_id: eventId(),
				item: { type: 'function_call_output', call_id: msg.call_id, output: 'ending' },
			});
			if (!forceTimer) forceTimer = setTimeout(() => finish('forced'), FORCE_CLOSE_AFTER_WRAP_MS);
			// The goodbye was already spoken; if this response has finished, hang up after playback.
			if (!activeResponse) sendBye();
			return;
		}
		safeSend(upstream, {
			type: 'conversation.item.create',
			event_id: eventId(),
			item: { type: 'function_call_output', call_id: msg.call_id, output: 'saved' },
		});
		safeSend(upstream, { type: 'response.create', event_id: eventId() });
	};

	function onAzureMessage(evt) {
		let msg;
		try {
			msg = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data));
		} catch {
			return;
		}
		switch (msg.type) {
			case 'response.audio.delta':
				if (msg.delta && streamSid && safeSend(twilio, azureDeltaToTwilio(streamSid, msg.delta))) stats.audioOut++;
				return;
			case 'input_audio_buffer.speech_started':
				lastActivity = Date.now();
				if (endRequested) return;
				if (greeting === 'playing') {
					greeting = 'interrupted';
					noteActive = true;
					safeSend(upstream, { type: 'session.update', event_id: eventId(), session: { instructions: `${baseInstructions}\n\n${interruptedNote(who)}` } });
				}
				safeSend(twilio, { event: 'clear', streamSid });
				if (activeResponse) safeSend(upstream, { type: 'response.cancel', event_id: eventId() });
				return;
			case 'input_audio_buffer.speech_stopped':
				lastActivity = Date.now();
				// Noise can cut the greeting with nothing intelligible behind it; never leave the line dead.
				if (noteActive && !noteReplyStarted && !nudgeTimer) {
					nudgeTimer = setTimeout(() => {
						if (closed || noteReplyStarted) return;
						safeSend(upstream, { type: 'response.create', event_id: eventId(), response: { instructions: `${baseInstructions}\n\n${MISSED_AUDIO_NOTE}` } });
					}, MISSED_AUDIO_NUDGE_MS);
				}
				return;
			case 'conversation.item.input_audio_transcription.completed':
				lastActivity = Date.now();
				if (msg.transcript?.trim()) lines.push({ speaker: 'lead', start: since(), text: msg.transcript.trim() });
				return;
			case 'response.audio_transcript.done':
				if (msg.transcript?.trim()) lines.push({ speaker: 'ai', start: since(), text: msg.transcript.trim() });
				return;
			case 'response.created':
				activeResponse = true;
				if (noteActive) {
					noteReplyStarted = true;
					clearTimeout(nudgeTimer);
				}
				if (wrapState === 'sent') {
					wrapState = 'speaking';
					endRequested = true;
				}
				return;
			case 'response.done':
				activeResponse = false;
				lastActivity = Date.now();
				if (noteActive && noteReplyStarted) {
					noteActive = false;
					safeSend(upstream, { type: 'session.update', event_id: eventId(), session: { instructions: baseInstructions } });
				}
				if (greeting === 'playing' && !greetingMarkSent && streamSid) {
					greetingMarkSent = true;
					safeSend(twilio, { event: 'mark', streamSid, mark: { name: GREETING_MARK } });
				}
				if (wrapState === 'pending') return sendWrap();
				if (endRequested) sendBye();
				return;
			case 'response.function_call_arguments.done':
				onToolCall(msg);
				return;
			case 'error': {
				const text = msg.error?.message ?? 'unknown';
				if (text.includes('Cancellation failed')) return;
				logWarn('phone.azure_error', new Error(text), { callSid });
				return;
			}
			default:
				return;
		}
	}

	twilio.addEventListener('message', (evt) => {
		if (typeof evt.data !== 'string' || evt.data.length > 65536) return;
		let msg;
		try {
			msg = JSON.parse(evt.data);
		} catch {
			return;
		}
		switch (msg.event) {
			case 'start':
				if (!callSid) startAi(msg.start || {}).catch((err) => {
					logError('phone.start', err);
					finish('start_error');
				});
				return;
			case 'media':
				if (configured && upstream && msg.media?.payload) {
					if (safeSend(upstream, twilioMediaToAzure(msg.media.payload))) stats.mediaIn++;
					else stats.sendFails++;
				}
				return;
			case 'mark':
				if (msg.mark?.name === BYE_MARK) finish('completed');
				if (msg.mark?.name === GREETING_MARK && greeting === 'playing') greeting = 'heard';
				return;
			case 'stop':
				finish(endRequested ? 'completed' : 'caller_hung_up');
				return;
			default:
				return;
		}
	});
	twilio.addEventListener('close', () => finish(endRequested ? 'completed' : 'caller_hung_up'));
	twilio.addEventListener('error', () => finish('twilio_error'));

	await closedPromise;
}
