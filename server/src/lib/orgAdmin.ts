import { readFileSync } from 'node:fs'
import type { Types } from 'mongoose'
import twilio from 'twilio'
import { secretContext } from './orgs.js'
import { seal } from './secrets.js'
import { toE164 } from './phone.js'

export type TwilioValues = {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  authToken: string
  twimlAppSid: string
  callerId: string
}

const KEYS: Record<keyof TwilioValues, string> = {
  accountSid: 'TWILIO_ACCOUNT_SID',
  apiKeySid: 'TWILIO_API_KEY_SID',
  apiKeySecret: 'TWILIO_API_KEY_SECRET',
  authToken: 'TWILIO_AUTH_TOKEN',
  twimlAppSid: 'TWILIO_TWIML_APP_SID',
  callerId: 'TWILIO_CALLER_ID',
}

// Same KEY=value shape as server/.env, read from a file so the secrets never pass through
// argv (shell history) or get printed.
export function readTwilioFile(path: string): TwilioValues {
  const found: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m?.[1] && m[2] !== undefined) found[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  const values = {} as TwilioValues
  for (const [field, key] of Object.entries(KEYS) as [keyof TwilioValues, string][]) {
    if (!found[key]) throw new Error(`${path} has no ${key}`)
    values[field] = found[key]
  }
  const callerId = toE164(values.callerId)
  if (!callerId) throw new Error(`TWILIO_CALLER_ID is not a valid phone number`)
  values.callerId = callerId
  return values
}

export type TwilioCheck = { ok: boolean; lines: string[]; voiceUrl: string | null }

// Read-only Twilio calls that catch the classic mistakes before anyone dials: the Auth Token
// swapped with the API key secret (every webhook 403s), a TwiML App or number from another
// account, and a TwiML App still pointing at the wrong Voice URL.
export async function checkTwilio(values: TwilioValues, expectedVoiceUrl: string): Promise<TwilioCheck> {
  const lines: string[] = []
  let ok = true
  let voiceUrl: string | null = null
  const fail = (msg: string) => {
    ok = false
    lines.push(`  ✗ ${msg}`)
  }

  const account = twilio(values.accountSid, values.authToken)
  try {
    const app = await account.applications(values.twimlAppSid).fetch()
    voiceUrl = app.voiceUrl
    lines.push(`  ✓ Auth Token works; TwiML App "${app.friendlyName}" is on this account`)
    if (app.voiceUrl !== expectedVoiceUrl) {
      lines.push(`  ! TwiML App Voice URL is ${app.voiceUrl || '(empty)'}; set it to ${expectedVoiceUrl}`)
    }
  } catch (err) {
    fail(`Auth Token or TwiML App SID rejected: ${(err as Error).message}`)
  }

  try {
    const numbers = await account.incomingPhoneNumbers.list({ phoneNumber: values.callerId, limit: 1 })
    if (numbers.length) lines.push(`  ✓ ${values.callerId} belongs to this account`)
    else fail(`${values.callerId} is not a number on this account`)
  } catch (err) {
    fail(`could not list numbers: ${(err as Error).message}`)
  }

  // A Standard key may not read the Account resource itself, so it is checked against the
  // TwiML App, which it can read, and which proves it belongs to the same account.
  try {
    await twilio(values.apiKeySid, values.apiKeySecret, { accountSid: values.accountSid })
      .applications(values.twimlAppSid)
      .fetch()
    lines.push('  ✓ API key and secret work')
  } catch (err) {
    fail(`API key SID or secret rejected: ${(err as Error).message}`)
  }

  return { ok, lines, voiceUrl }
}

export function twilioUpdate(orgId: Types.ObjectId, values: TwilioValues) {
  return {
    'twilio.accountSid': values.accountSid,
    'twilio.apiKeySid': values.apiKeySid,
    'twilio.twimlAppSid': values.twimlAppSid,
    'twilio.callerId': values.callerId,
    'twilio.secrets': {
      apiKeySecret: seal(values.apiKeySecret, secretContext(orgId, 'apiKeySecret')),
      authToken: seal(values.authToken, secretContext(orgId, 'authToken')),
    },
  }
}
