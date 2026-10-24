import { env } from '../config/env.js'
import type { Disposition } from '../models/Lead.js'

// Outcomes that aren't a final answer — try again another day, at a different hour.
const RETRYABLE: readonly Disposition[] = ['no_answer', 'voicemail', 'busy', 'hung_up', 'other']

export function isRetryable(disposition: Disposition): boolean {
  return RETRYABLE.includes(disposition)
}

export type RetryPlan = { exhausted: true } | { exhausted: false; at: Date }

function hourInZone(date: Date, timeZone: string): number {
  const shown = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit' }).format(date),
  )
  return shown === 24 ? 0 : shown
}

function weekdayInZone(date: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date)
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name) + 1
}

// The UTC instant at which `timeZone` reads `hour:00` on the calendar day
// `dayOffset` days after `from`. Corrected iteratively rather than by offset math
// so a retry that lands across a DST boundary still fires at the intended hour.
function instantAtZoneHour(from: Date, dayOffset: number, hour: number, timeZone: string): Date {
  const shifted = new Date(from.getTime() + dayOffset * 86_400_000)
  const [y = 1970, m = 1, d = 1] = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(shifted)
    .split('-')
    .map(Number)

  let guess = Date.UTC(y, m - 1, d, hour, 0, 0)
  for (let i = 0; i < 3; i++) {
    const diff = hour - hourInZone(new Date(guess), timeZone)
    if (diff === 0) break
    guess += diff * 3_600_000
  }
  return new Date(guess)
}

/**
 * When to try this lead again. `attempts` is the total placed so far (already
 * incremented by the voice webhook), so it doubles as the rotation index.
 *
 * The hour rotates across the calling window on every attempt: someone who never
 * answers at 9am gets tried at 1pm, then 4pm. Varied hours are most of where a
 * cold list's connect rate actually comes from — repeating the same slot five
 * times mostly re-proves that they are busy at that time.
 */
export function planRetry(attempts: number, from: Date = new Date()): RetryPlan {
  const { timeZone, startHour, endHour, days } = env.callWindow
  const { gapDays, maxAttempts } = env.retry

  if (attempts >= maxAttempts) return { exhausted: true }

  const hours: number[] = []
  for (let h = startHour; h < endHour; h++) hours.push(h)
  if (hours.length === 0) return { exhausted: true }

  // Alternate afternoon/morning rather than stepping through the window in order:
  // 9am → 2pm → 10am → 3pm actually tests different parts of their day, whereas
  // 9,10,11,12 re-proves the same thing four times.
  const mid = Math.ceil(hours.length / 2)
  const order: number[] = []
  for (let i = 0; i < mid; i++) {
    const late = hours[mid + i]
    const early = hours[i]
    if (late !== undefined) order.push(late)
    if (early !== undefined) order.push(early)
  }

  const hour = order[attempts % order.length] ?? startHour

  for (let extra = 0; extra < 7; extra++) {
    const candidate = instantAtZoneHour(from, gapDays + extra, hour, timeZone)
    if (days.includes(weekdayInZone(candidate, timeZone))) return { exhausted: false, at: candidate }
  }

  // No permitted weekday in the next week means the window config is unusable.
  return { exhausted: true }
}
