export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Logins are "first.company" (sam.acme), so the first part is the person.
export function callerName(username: string | null): string {
  const first = username?.split('.')[0]
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : '—'
}

export const TRANSCRIPT_FAILED_TEXT: Record<string, string> = {
  'recorder-start': "Recording didn't start",
  'empty-recording': 'Recording came out empty',
  'no-call-id': "Couldn't match the call",
  'too-short': 'Too short to transcribe',
  decode: "Recording couldn't be read",
  'model-load': "Transcriber didn't load",
  garbled: 'Transcriber returned nonsense',
  expired: 'Waited over 48 h, dropped',
  transcribe: 'Transcribing failed',
  'worker-crash': 'Transcriber crashed',
  'no-speech': 'No speech heard',
  'silent-audio': 'Mic recorded silence',
  upload: "Made but couldn't be saved",
}
