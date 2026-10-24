export function memoryKv({ failGets = false } = {}) {
	const store = new Map();
	return {
		store,
		async get(key) {
			if (failGets) throw new Error('kv down');
			return store.has(key) ? store.get(key) : null;
		},
		async put(key, value) {
			store.set(key, String(value));
		},
		async delete(key) {
			store.delete(key);
		},
	};
}

export function testEnv(overrides = {}) {
	return {
		AI_ENABLED: 'true',
		AZURE_VOICELIVE_ENDPOINT: 'https://example.services.ai.azure.com/',
		AZURE_VOICELIVE_API_KEY: 'test-key',
		TWILIO_AUTH_TOKEN: 'test-auth-token',
		TICKET_SECRET: 'test-ticket-secret',
		INBOUND_SHARED_SECRET: 'shared-secret-123',
		INBOUND_CLIENTS: 'jordan.acme',
		INBOUND_RING_SECONDS: '10',
		DIALDESK_URL: 'https://dialdesk.example.com',
		PHONE_MAX_DAILY_SECONDS: '3600',
		PHONE_MAX_AI_PER_NUMBER_PER_DAY: '3',
		PHONE_MAX_CONCURRENT: '2',
		RECEPTIONIST_KV: memoryKv(),
		...overrides,
	};
}

export function fakeCtx() {
	const pending = [];
	return { pending, waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending) };
}

export function stubFetch(handler) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init = {}) => {
		calls.push({ url: String(url), init });
		return handler(String(url), init);
	};
	return { calls, restore: () => (globalThis.fetch = original) };
}
