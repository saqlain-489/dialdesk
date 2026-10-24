import type { AiSummary, InboundHandler } from '../types'

export const INBOUND_LABEL: Record<InboundHandler, string> = {
  human: 'you answered',
  ai: 'AI answered',
  missed: 'missed',
}

const SUMMARY_ROWS: [keyof Omit<AiSummary, 'flags'>, string][] = [
  ['name', 'Name'],
  ['business', 'Business'],
  ['reason', 'Reason'],
  ['bestTime', 'Call back'],
  ['callbackNumber', 'Number'],
  ['email', 'Email'],
  ['notes', 'Notes'],
]

export function summaryRows(s: AiSummary | null): [string, string][] {
  if (!s) return []
  const rows = SUMMARY_ROWS.filter(([k]) => s[k]).map(([k, label]) => [label, s[k] as string] as [string, string])
  if (s.flags?.length) rows.push(['Flags', s.flags.join(', ')])
  return rows
}

// Receptionist reason codes (receptionist/src/inbound.js REASON_TEXT, phone.js finish()).
const REASON_TEXT: Record<string, string> = {
  caller_hung_up_ringing: 'hung up while ringing',
  disabled: 'AI switched off',
  not_configured: 'AI not set up yet',
  daily_budget: "today's AI minutes used up",
  number_cap: 'number hit its AI limit today',
  busy: 'AI lines busy',
  kv_error: 'budget check failed',
  ai_unavailable: 'AI could not connect',
  caller_hung_up: 'they hung up',
  time_limit: 'hit the AI time limit',
  forced: 'closed after the goodbye',
}
const AI_FAULTS = new Set(['upstream_error', 'upstream_closed', 'azure_failed', 'start_error', 'no_start', 'twilio_error', 'bad_ticket'])

export function inboundReasonText(reason: string | null): string | null {
  if (!reason || reason === 'completed') return null
  if (AI_FAULTS.has(reason)) return `AI connection problem (${reason})`
  return REASON_TEXT[reason] ?? reason
}
