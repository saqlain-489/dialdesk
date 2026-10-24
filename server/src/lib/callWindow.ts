import { env } from '../config/env.js'

export type CallWindowState = {
  open: boolean
  reason: string
  leadLocalTime: string
  leadTimeZone: string
}

// Wall-clock hour and ISO weekday (1=Mon..7=Sun) in the leads' timezone.
// Intl handles DST, so this stays correct across a daylight-saving switch.
function partsInZone(date: Date, timeZone: string): { hour: number; weekday: number; label: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts = fmt.formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''

  const hour = Number(get('hour'))
  const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const weekday = weekdayNames.indexOf(get('weekday')) + 1

  return { hour, weekday, label: `${get('weekday')} ${get('hour')}:${get('minute')}` }
}

export function checkCallWindow(now: Date = new Date()): CallWindowState {
  const { timeZone, startHour, endHour, days } = env.callWindow
  const { hour, weekday, label } = partsInZone(now, timeZone)

  const base = { leadLocalTime: label, leadTimeZone: timeZone }

  if (!days.includes(weekday)) {
    return { ...base, open: false, reason: `Outside calling days (lead local time ${label})` }
  }
  if (hour < startHour || hour >= endHour) {
    return {
      ...base,
      open: false,
      reason: `Outside ${startHour}:00–${endHour}:00 in ${timeZone} (lead local time ${label})`,
    }
  }
  return { ...base, open: true, reason: `Open (lead local time ${label})` }
}
