// Azure Voice Live wire protocol. No SDK: @azure/ai-voicelive opens sockets with
// `new WebSocket(url)`, which Workers do not support for outbound; Workers upgrade via fetch().

export const eventId = () => `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

export function safeSend(socket, payload) {
	try {
		socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
		return true;
	} catch {
		return false;
	}
}

export function resolveVoiceConfig(voiceName) {
	const azure = voiceName.includes('-') || voiceName.includes(':');
	return azure ? { type: 'azure-standard', name: voiceName } : { type: 'openai', name: voiceName };
}

export function buildAzureUrl(endpoint, apiVersion, model) {
	// fetch() upgrades from https://, not wss://.
	const url = new URL(endpoint);
	if (url.protocol === 'ws:') url.protocol = 'http:';
	if (url.protocol === 'wss:') url.protocol = 'https:';
	url.pathname = '/voice-live/realtime';
	url.searchParams.set('api-version', apiVersion);
	url.searchParams.set('model', model);
	return url.toString();
}

export function azureSettings(env) {
	return {
		model: env.AZURE_VOICELIVE_MODEL || 'gpt-4o-mini',
		voice: env.AZURE_VOICELIVE_VOICE || 'en-US-Ava:DragonHDLatestNeural',
		apiVersion: env.AZURE_VOICELIVE_API_VERSION || '2025-10-01',
	};
}

// Phone audio is G.711 mu-law 8 kHz on both sides, so Twilio payloads pass through untouched.
export function phoneSessionUpdate({ model, voice, instructions, tools }) {
	return {
		type: 'session.update',
		event_id: eventId(),
		session: {
			model,
			modalities: ['text', 'audio'],
			instructions,
			voice: resolveVoiceConfig(voice),
			input_audio_format: 'g711_ulaw',
			output_audio_format: 'g711_ulaw',
			turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 },
			input_audio_echo_cancellation: { type: 'server_echo_cancellation' },
			input_audio_noise_reduction: { type: 'azure_deep_noise_suppression' },
			input_audio_transcription: { model: 'azure-speech' },
			tools,
			tool_choice: 'auto',
		},
	};
}

export function greetingEvent(text) {
	return {
		type: 'response.create',
		event_id: eventId(),
		response: { pre_generated_assistant_message: { content: [{ type: 'text', text }] } },
	};
}

// Returns an accepted WebSocket, or throws. The upgrade error body is logged by the caller
// truncated; it never contains the key, which only travels in the request header.
export async function connectAzure(env) {
	const { model, apiVersion } = azureSettings(env);
	const res = await fetch(buildAzureUrl(env.AZURE_VOICELIVE_ENDPOINT, apiVersion, model), {
		headers: { Upgrade: 'websocket', 'api-key': env.AZURE_VOICELIVE_API_KEY },
	});
	if (res.status !== 101 || !res.webSocket) {
		const body = await res.text().catch(() => '');
		const err = new Error(`azure upgrade ${res.status}`);
		err.detail = body.slice(0, 200);
		throw err;
	}
	res.webSocket.accept();
	return res.webSocket;
}
