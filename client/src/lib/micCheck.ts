// Thresholds come from docs/call-audio.md: charger hum, a cable mic far from the mouth, clipping.

export type MicProblem = 'hum' | 'weak-voice' | 'too-quiet' | 'clipping' | 'no-voice'

export type MicCheck = {
  humDb: number
  voiceDb: number
  noiseDb: number
  snrDb: number
  clippedPct: number
  problems: MicProblem[]
}

export const MIC_PROBLEM_TEXT: Record<MicProblem, string> = {
  hum: 'Electrical hum is drowning your voice. Unplug the laptop charger (or use a grounded socket) and test again.',
  'weak-voice': 'Your voice is too close to the background noise. Move the mic to just under your chin and test again.',
  'too-quiet': 'Your mic is very quiet. Raise the input volume in Sound settings and test again.',
  clipping: 'Your mic is so loud it distorts. Lower the input volume in Sound settings a little and test again.',
  'no-voice': 'No speech was heard. Read your opener out loud during the test.',
}

// Charger hum measured +9 dB over the voice; on battery it was 26 dB under and level with the noise floor.
const HUM_MARGIN_DB = -12
const HUM_OVER_NOISE_DB = 10
// Prospects complained at ~14 dB; the fixed mic chain measured ~24 dB.
const MIN_SNR_DB = 18
const MIN_VOICE_DB = -38
const MAX_CLIPPED_PCT = 0.01
const MIN_SPEECH_OVER_NOISE_DB = 6

const toDb = (amplitude: number) => 20 * Math.log10(Math.max(amplitude, 1e-9))

function biquad(input: Float32Array, sampleRate: number, type: 'highpass' | 'lowpass', freq: number): Float32Array {
  const w = (2 * Math.PI * freq) / sampleRate
  const cos = Math.cos(w)
  const alpha = Math.sin(w) * Math.SQRT1_2
  const b1 = type === 'highpass' ? -(1 + cos) : 1 - cos
  const b0 = Math.abs(b1) / 2
  const a0 = 1 + alpha
  const out = new Float32Array(input.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x = input[i] ?? 0
    const y = (b0 * x + b1 * x1 + b0 * x2 + 2 * cos * y1 - (1 - alpha) * y2) / a0
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    out[i] = y
  }
  return out
}

// Goertzel: RMS of the sine component at `freq` within one block.
function toneRms(x: Float32Array, start: number, n: number, sampleRate: number, freq: number): number {
  const k = 2 * Math.cos((2 * Math.PI * freq) / sampleRate)
  let s1 = 0, s2 = 0
  for (let i = start; i < start + n; i++) {
    const s = (x[i] ?? 0) + k * s1 - s2
    s2 = s1
    s1 = s
  }
  return (Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) * Math.SQRT2) / n
}

// Mains is 50 Hz in most of the world and 60 Hz in the Americas; ±1 Hz covers grid drift.
const HUM_FREQS = [49, 50, 51, 59, 60, 61]

function humLevel(x: Float32Array, sampleRate: number): number {
  const block = Math.floor(sampleRate / 2)
  let power = 0, blocks = 0
  for (let start = 0; start + block <= x.length; start += block) {
    const rms = Math.max(...HUM_FREQS.map((f) => toneRms(x, start, block, sampleRate, f)))
    power += rms * rms
    blocks++
  }
  return blocks ? Math.sqrt(power / blocks) : 0
}

export function analyzeMic(samples: Float32Array, sampleRate: number): MicCheck {
  const band = biquad(biquad(samples, sampleRate, 'highpass', 300), sampleRate, 'lowpass', 3400)
  const win = Math.floor(sampleRate * 0.05)
  const windows: number[] = []
  for (let start = 0; start + win <= band.length; start += win) {
    let sum = 0
    for (let i = start; i < start + win; i++) sum += (band[i] ?? 0) ** 2
    windows.push(Math.sqrt(sum / win))
  }
  windows.sort((a, b) => a - b)
  const pct = (p: number) => windows[Math.min(windows.length - 1, Math.floor(p * windows.length))] ?? 0

  let clipped = 0
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i] ?? 0) >= 0.99) clipped++

  const voiceDb = toDb(pct(0.9))
  const noiseDb = toDb(pct(0.1))
  const humDb = toDb(humLevel(samples, sampleRate))
  const snrDb = voiceDb - noiseDb
  const clippedPct = samples.length ? (clipped / samples.length) * 100 : 0

  const problems: MicProblem[] = []
  if (humDb > Math.max(voiceDb + HUM_MARGIN_DB, noiseDb + HUM_OVER_NOISE_DB)) problems.push('hum')
  if (snrDb < MIN_SPEECH_OVER_NOISE_DB) problems.push('no-voice')
  else {
    if (snrDb < MIN_SNR_DB) problems.push('weak-voice')
    if (voiceDb < MIN_VOICE_DB) problems.push('too-quiet')
  }
  if (clippedPct > MAX_CLIPPED_PCT) problems.push('clipping')

  return { humDb, voiceDb, noiseDb, snrDb, clippedPct, problems }
}
