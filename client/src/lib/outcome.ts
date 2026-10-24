import type { Disposition } from '../types'

export const OUTCOME_LABEL: Record<Disposition, string> = {
  no_answer: 'No answer',
  voicemail: 'Voicemail',
  busy: 'Busy',
  connected: 'Talked, neutral',
  not_interested: 'Not interested',
  interested: 'Interested',
  callback_later: 'Call back later',
  booked: 'Booked',
  wrong_number: 'Wrong number',
  do_not_call: 'Do not call',
  hung_up: 'Hung up',
  other: 'Other',
}

const TONE: Partial<Record<Disposition, string>> = {
  booked: 'green',
  interested: 'green',
  callback_later: 'purple',
  voicemail: 'yellow',
  not_interested: 'red',
  wrong_number: 'red',
  do_not_call: 'red',
  hung_up: 'red',
}

export function outcomeText(disposition: Disposition, label: string | null): string {
  return disposition === 'other' && label ? `Other: ${label}` : OUTCOME_LABEL[disposition]
}

export const outcomeTone = (disposition: Disposition): string => TONE[disposition] ?? ''
