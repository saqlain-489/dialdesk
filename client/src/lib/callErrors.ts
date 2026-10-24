export type TwilioLikeError = { code?: number; message?: string; name?: string }

export type Friendly = { title: string; action: string; code?: number }

const INTERNET: Friendly = {
  title: "Can't reach the phone service",
  action: 'Your internet dropped or is blocking calls. Check your connection, turn off any VPN, then try again.',
}
const MIC_BLOCKED: Friendly = {
  title: 'Microphone is blocked',
  action: 'Click the lock icon next to the website address, allow Microphone, then refresh the page.',
}
const MIC_MISSING: Friendly = {
  title: 'No microphone found',
  action: 'Plug in your headset, then refresh the page.',
}
const SESSION: Friendly = {
  title: 'Your calling session expired',
  action: 'Refresh the page and try the call again.',
}
const AUDIO: Friendly = {
  title: 'Voice connection failed',
  action: 'Your network is blocking call audio. Switch to wired internet or another network and try again.',
}
const DROPPED: Friendly = {
  title: 'The call dropped',
  action: 'Usually a short internet hiccup. Call them back — say the line cut out.',
}
const SETUP: Friendly = {
  title: 'Calling is not set up correctly',
  action: 'This is a settings problem, not your internet. Stop calling and tell the workspace owner.',
}

const BY_CODE: Record<number, Friendly> = {
  31000: DROPPED,
  31005: DROPPED,
  31003: INTERNET,
  31009: INTERNET,
  53000: INTERNET,
  53001: INTERNET,
  53002: INTERNET,
  31401: MIC_BLOCKED,
  31208: MIC_BLOCKED,
  31402: MIC_MISSING,
  31201: MIC_MISSING,
  20101: SESSION,
  20104: SESSION,
  31202: SESSION,
  31204: SESSION,
  31205: SESSION,
  31206: SESSION,
  53405: AUDIO,
  53407: AUDIO,
  31002: SETUP,
  31100: SETUP,
  20151: SETUP,
  31486: { title: 'Line is busy', action: 'Pick "Busy" — it will be retried later.' },
  31480: {
    title: "Their phone couldn't be reached",
    action: 'Their phone is off or out of service. Pick "No answer"; if it happens again, the number is probably dead.',
  },
  31603: { title: 'They rejected the call', action: 'Pick "No answer" and move on.' },
  31404: { title: 'That number does not exist', action: 'Archive this lead — the number is dead.' },
}

// Errors the gateway raises when the lead's leg ends before pickup. With answerOnBridge the
// browser leg is never "answered", so a plain no-answer surfaces as one of these.
const PRE_ANSWER_HANGUP = new Set([31000, 31005, 31480, 31486, 31603, 31404])

export function isPreAnswerHangup(err: TwilioLikeError): boolean {
  return err.code !== undefined && PRE_ANSWER_HANGUP.has(err.code)
}

export function friendlyError(err: unknown): Friendly {
  const e = (err ?? {}) as TwilioLikeError
  if (e.name === 'NotAllowedError' || e.name === 'SecurityError') return MIC_BLOCKED
  if (e.name === 'NotFoundError') return MIC_MISSING
  const known = e.code !== undefined ? BY_CODE[e.code] : undefined
  if (known) return { ...known, code: e.code }
  if (/websocket|network|failed to fetch|timed? ?out/i.test(e.message ?? '')) return { ...INTERNET, code: e.code }
  if (/token/i.test(e.message ?? '')) return { ...SESSION, code: e.code }
  return {
    title: 'Something went wrong with the call',
    action: 'Try again. If it keeps happening, tell the workspace owner.',
    code: e.code,
  }
}

export function formatFriendly(f: Friendly): string {
  return `${f.title}. ${f.action}${f.code ? ` (code ${f.code})` : ''}`
}

export function dialOutcome(status: string): Friendly {
  switch (status) {
    case 'no-answer':
      return { title: 'No answer', action: 'It rang for 25 seconds. Pick "No answer".' }
    case 'busy':
      return { title: 'Line was busy', action: 'Pick "Busy" — it will be retried later.' }
    case 'failed':
      return {
        title: "Their phone couldn't be reached",
        action: 'Their phone is off or out of service. Pick "No answer"; if it happens again, the number is probably dead.',
      }
    case 'canceled':
      return { title: 'You hung up before they answered', action: 'Pick "No answer".' }
    case 'completed':
      return { title: 'Call finished', action: 'Pick how it went.' }
    default:
      return { title: `Call ended (${status})`, action: 'Pick how it went.' }
  }
}
