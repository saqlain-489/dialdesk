// One worker answers every workspace's Twilio number. Each workspace's account, who to ring
// and what the receptionist calls the business live in the ORG_CONFIG secret (JSON keyed by
// the dialdesk workspace slug). Without ORG_CONFIG the single-number setup in the plain env
// vars keeps working, as the workspace "default".

import { DEFAULT_WHO } from './persona.js';
import { parseClients } from './twilio.js';

export const DEFAULT_ORG = 'default';
const SLUG = /^[a-z0-9-]{2,32}$/;

let parsedFrom = null;
let parsed = null;

function configMap(env) {
	if (!env.ORG_CONFIG) return null;
	if (env.ORG_CONFIG !== parsedFrom) {
		parsedFrom = env.ORG_CONFIG;
		parsed = JSON.parse(env.ORG_CONFIG);
	}
	return parsed;
}

function normalize(slug, raw, env) {
	return {
		slug,
		legacy: slug === legacyOrgSlug(env),
		// Sent to dialdesk with each call; null for "default", which dialdesk routes by number alone.
		ingestSlug: slug === DEFAULT_ORG ? null : slug,
		accountSid: raw.accountSid || '',
		authToken: raw.authToken || '',
		clients: Array.isArray(raw.clients) ? parseClients(raw.clients.join(',')) : parseClients(raw.clients),
		companyName: raw.companyName || env.COMPANY_NAME || DEFAULT_WHO.companyName,
		ownerName: raw.ownerName || env.OWNER_NAME || DEFAULT_WHO.person,
		discordWebhookUrl: raw.discordWebhookUrl || env.DISCORD_WEBHOOK_URL || '',
	};
}

// The workspace for a slug from the URL, or null if this worker doesn't serve it.
export function orgFor(env, slug) {
	if (!SLUG.test(slug || '')) return null;
	const map = configMap(env);
	if (map) return map[slug] ? normalize(slug, map[slug], env) : null;
	if (slug !== DEFAULT_ORG) return null;
	return normalize(
		DEFAULT_ORG,
		{ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, clients: env.INBOUND_CLIENTS },
		env,
	);
}

// Numbers still pointed at the pre-workspace /twilio/<action> URLs belong to this workspace.
// LEGACY_ORG only means something alongside ORG_CONFIG; on its own it must not orphan them.
export function legacyOrgSlug(env) {
	return env.ORG_CONFIG ? env.LEGACY_ORG || DEFAULT_ORG : DEFAULT_ORG;
}

// KV key for a lead's context. The legacy workspace also reads the old unprefixed key,
// written before workspaces, until it expires or is pushed again.
export function leadKeys(org, phone) {
	const keys = [org.slug === DEFAULT_ORG ? `lead:${phone}` : `lead:${org.slug}:${phone}`];
	if (org.legacy && org.slug !== DEFAULT_ORG) keys.push(`lead:${phone}`);
	return keys;
}

// The name the receptionist uses for the person who will call back: whoever last spoke to
// this caller, else the workspace's owner name.
export function personFor(org, lead) {
	return lead?.callerName || org?.ownerName || DEFAULT_WHO.person;
}
