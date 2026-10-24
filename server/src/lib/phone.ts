import parsePhoneNumberFromString from 'libphonenumber-js'

// Leads arrive from list exports and hand-made sheets, so formats vary wildly:
// "+12125550143", "(212) 555-0143", "212-555-0143 ext 2". Everything is normalized
// to E.164 once, at the import boundary, so the rest of the app can assume it.
export function toE164(raw: string, defaultCountry: 'US' = 'US'): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry)
  if (!parsed || !parsed.isValid()) return null

  return parsed.number
}

export function formatForDisplay(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164)
  return parsed ? parsed.formatNational() : e164
}

// Guards the TwiML webhook. Even with the lead allowlist, this keeps anything
// non-US-dialable from reaching <Dial>.
export function isDialableUsNumber(e164: string): boolean {
  return /^\+1[2-9]\d{9}$/.test(e164)
}
