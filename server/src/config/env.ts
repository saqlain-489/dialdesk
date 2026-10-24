import 'dotenv/config'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (Number.isNaN(parsed)) throw new Error(`Env var ${name} must be a number, got "${raw}"`)
  return parsed
}

function csv(name: string, fallback: string): number[] {
  return optional(name, fallback)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !Number.isNaN(n))
}

export const env = {
  port: num('PORT', 4001),
  publicUrl: optional('PUBLIC_URL', 'http://localhost:4001').replace(/\/$/, ''),
  mongoUri: optional('MONGO_URI', 'mongodb://127.0.0.1:27017/dialdesk'),
  isProduction: process.env.NODE_ENV === 'production',

  jwtSecret: required('JWT_SECRET'),
  // Seals each workspace's Twilio secrets in the database (AES-256-GCM). Losing it means
  // re-entering every workspace's keys with `npm run org -- set-twilio`.
  orgSecretsKey: process.env.ORG_SECRETS_KEY || '',

  twilio: {
    // Short TTL keeps a leaked token near-worthless; the SDK refreshes transparently
    // via the tokenWillExpire event.
    tokenTtlSeconds: num('TWILIO_TOKEN_TTL', 600),
    // TwiML Apps configured before workspaces post to /api/twilio/voice with no slug in
    // the path; this names the workspace those requests belong to. Empty refuses them.
    legacyWebhookOrg: optional('LEGACY_WEBHOOK_ORG', ''),
  },

  callWindow: {
    timeZone: optional('CALL_TZ', 'America/New_York'),
    startHour: num('CALL_WINDOW_START', 9),
    endHour: num('CALL_WINDOW_END', 17),
    days: csv('CALL_WINDOW_DAYS', '1,2,3,4,5'),
  },

  // Shared with the receptionist worker (receptionist/): it posts inbound calls to
  // /api/inbound/ingest, and receives lead context from here. Empty disables both.
  inbound: {
    sharedSecret: process.env.INBOUND_SHARED_SECRET || '',
    receptionistUrl: optional('RECEPTIONIST_URL', '').replace(/\/$/, ''),
  },

  retry: {
    gapDays: num('RETRY_GAP_DAYS', 3),
    maxAttempts: num('MAX_ATTEMPTS', 5),
  },

  // A lost lead may move to another workspace (a fresh caller) only after resting this long
  // since its last call: the industry's 60–90 day cooling-off before an account is recycled.
  recycle: {
    restDays: num('RECYCLE_REST_DAYS', 60),
  },

  // Recording without telling the lead rests on one-party consent, and the one consenting
  // party is the CALLER, so they have to know it is on. All-party states (CA, FL, IL, MD,
  // MA, MT, NH, PA, WA…) need everyone's consent, so leads are allowed by state code rather
  // than by anyone remembering the rule mid-shift. Empty means nobody is recorded.
  transcription: {
    enabled: optional('TRANSCRIBE_ENABLED', 'true') === 'true',
    states: optional('TRANSCRIBE_STATES', '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    model: optional('TRANSCRIBE_MODEL', 'Xenova/whisper-base.en'),
  },
} as const
