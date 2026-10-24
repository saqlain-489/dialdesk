import type { AiSummary, Disposition, InboundHandler, Lead, LeadStatus, TranscriptDetail, TranscriptLine } from '../types'

// Everything here is fictional: Acme Co., its teams and leads, and 555-01XX phone numbers.

export type DemoOrg = {
  id: string
  slug: string
  name: string
  companyName: string
  callerId: string
  callers: { username: string; displayName: string }[]
}

export const DEMO_ORGS: DemoOrg[] = [
  {
    id: 'org-north',
    slug: 'north',
    name: 'North',
    companyName: 'Acme Co.',
    callerId: '+12125550190',
    callers: [
      { username: 'sam.acme', displayName: 'Sam' },
      { username: 'jordan.acme', displayName: 'Jordan' },
    ],
  },
  {
    id: 'org-south',
    slug: 'south',
    name: 'South',
    companyName: 'Acme Co.',
    callerId: '+13125550191',
    callers: [
      { username: 'alex.acme', displayName: 'Alex' },
      { username: 'jordan.acme', displayName: 'Jordan' },
    ],
  },
]

export const DEMO_USER = { id: 'user-jordan', username: 'jordan.acme', displayName: 'Jordan' }
export const DEMO_TIME_ZONE = 'America/New_York'
// One-party-consent states in the fictional list; CA and WA leads show "Transcript off".
export const DEMO_TRANSCRIBE_STATES = ['NY', 'OH', 'GA', 'CO', 'NC', 'AZ', 'NJ']

export type DemoLead = Lead & { orgId: string; claimed: boolean }

export type DemoCall = {
  id: string
  orgId: string
  direction: 'outbound' | 'inbound'
  leadId: string | null
  username: string | null
  attemptNumber: number | null
  startedAt: string
  answeredAt: string | null
  endedAt: string | null
  duration: number
  dialStatus: string | null
  disposition: Disposition | null
  dispositionLabel: string | null
  handledBy: InboundHandler | null
  inboundReason: string | null
  fromNumber: string | null
  parentCallSid: string
  aiSummary: AiSummary | null
  transcript: { text: string; lines: TranscriptLine[]; model: string | null; processingSeconds: number | null } | null
  transcriptError: { stage: string; message: string | null } | null
  quality: TranscriptDetail['quality']
}

const PLACES: [city: string, state: string, areaCode: string][] = [
  ['Albany', 'NY', '518'],
  ['Columbus', 'OH', '614'],
  ['Savannah', 'GA', '912'],
  ['Denver', 'CO', '303'],
  ['Raleigh', 'NC', '919'],
  ['Phoenix', 'AZ', '602'],
  ['Hoboken', 'NJ', '201'],
  ['Buffalo', 'NY', '716'],
  ['Cleveland', 'OH', '216'],
  ['Atlanta', 'GA', '404'],
  ['Boulder', 'CO', '720'],
  ['Asheville', 'NC', '828'],
  ['Tucson', 'AZ', '520'],
  ['San Diego', 'CA', '619'],
  ['Seattle', 'WA', '206'],
  ['Trenton', 'NJ', '609'],
]

const NAMES: [name: string, category: string][] = [
  ['Bluebird Bakery', 'Bakery'],
  ['Cedar Dental Studio', 'Dentist'],
  ['Harbor Pet Grooming', 'Pet groomer'],
  ['Maple Street Florist', 'Florist'],
  ['Northside Auto Repair', 'Auto repair'],
  ['Pinecrest Plumbing, LLC', 'Plumber'],
  ['Riverbend Yoga', 'Yoga studio'],
  ['Summit Physical Therapy', 'Physical therapy'],
  ['Golden Crust Pizza', 'Pizza'],
  ['Lakeside Landscaping', 'Landscaper'],
  ['Brightside Cleaning Co.', 'Cleaning service'],
  ['Oak & Iron Furniture', 'Furniture maker'],
  ['Desert Bloom Spa', 'Day spa'],
  ['Sunrise Daycare', 'Daycare'],
  ['Evergreen Tree Service', 'Tree service'],
  ['Copper Kettle Cafe', 'Cafe'],
  ['Redwood Chiropractic', 'Chiropractor'],
  ['Ironclad Fitness', 'Gym'],
  ['Silver Birch Bike Shop', 'Bike shop'],
  ['Willow Creek Veterinary', 'Veterinarian'],
  ['Granite Peak HVAC', 'HVAC'],
  ['Blue Heron Bookshop', 'Bookshop'],
  ['Fox Hollow Electric', 'Electrician'],
  ['Elm Street Barbers', 'Barber'],
  ['Twin Pines Painting', 'Painter'],
  ['Stonegate Locksmith', 'Locksmith'],
  ['Meadowlark Music School', 'Music school'],
  ['Clearwater Pool Service', 'Pool service'],
  ['High Desert Optometry', 'Optometrist'],
  ['Old Mill Print Shop', 'Print shop'],
  ['Juniper Garden Center', 'Garden center'],
  ['Bayview Catering', 'Caterer'],
  ['Hilltop Tutoring', 'Tutoring'],
  ['Lantern Photography', 'Photographer'],
  ['Orchard Lane Deli', 'Deli'],
  ['Prairie Wind Massage', 'Massage'],
  ['Quarry Road Hardware', 'Hardware store'],
  ['Ridgeline Pest Control', 'Pest control'],
  ['Saltbox Seafood', 'Seafood restaurant'],
  ['Thistle Tea House', 'Tea house'],
  ['Union Square Tailors', 'Tailor'],
  ['Walnut Grove Pediatrics', 'Pediatrician'],
  ['Zephyr Cycles', 'Bike shop'],
  ['Amber Lane Candles', 'Candle maker'],
  ['Beacon Hill Notary', 'Notary'],
  ['Cobalt Car Wash', 'Car wash'],
  ['Driftwood Surf School', 'Surf school'],
  ['Emberline Pottery', 'Pottery studio'],
  ['Foxglove Bridal', 'Bridal shop'],
  ['Gull Point Marina', 'Marina'],
]

const PEOPLE: [fullName: string, first: string][] = [
  ['Dana Whitfield', 'Dana'],
  ['Priya Raman', 'Priya'],
  ['Marcus Bell', 'Marcus'],
  ['Elena Brooks', 'Elena'],
  ['Tom Kessler', 'Tom'],
  ['Grace Okafor', 'Grace'],
  ['Luis Romero', 'Luis'],
  ['Hannah Weiss', 'Hannah'],
  ['Omar Haddad', 'Omar'],
  ['Nina Petrova', 'Nina'],
  ['Ben Carter', 'Ben'],
  ['Ruth Lindqvist', 'Ruth'],
]

const ISSUE_SETS: string[][] = [
  ['not_mobile', 'no_form'],
  ['no_https', 'outdated'],
  ['site_down'],
  ['outdated', 'no_form'],
  [],
  ['parked_domain'],
  ['no_https'],
  ['not_mobile', 'outdated', 'no_https'],
]

type Plan = { status: LeadStatus; attempts: number; last: Disposition | null; due: 'past' | 'future' | null; archived?: string }

// The North team's pipeline, lead by lead: the first 20 are callable now, the rest are history.
const NORTH_PLAN: Plan[] = [
  { status: 'contacted', attempts: 1, last: 'voicemail', due: 'past' },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'callback', attempts: 2, last: 'callback_later', due: 'past' },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'contacted', attempts: 2, last: 'no_answer', due: 'past' },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'contacted', attempts: 3, last: 'busy', due: 'past' },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'callback', attempts: 1, last: 'interested', due: 'past' },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'contacted', attempts: 1, last: 'hung_up', due: 'past' },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'contacted', attempts: 2, last: 'voicemail', due: 'past' },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'new', attempts: 0, last: null, due: null },
  { status: 'contacted', attempts: 2, last: 'voicemail', due: 'future' },
  { status: 'callback', attempts: 2, last: 'callback_later', due: 'future' },
  { status: 'booked', attempts: 2, last: 'booked', due: null },
  { status: 'booked', attempts: 3, last: 'booked', due: null },
  { status: 'won', attempts: 3, last: 'booked', due: null },
  { status: 'lost', attempts: 1, last: 'not_interested', due: null },
  { status: 'lost', attempts: 2, last: 'not_interested', due: null },
  { status: 'lost', attempts: 5, last: 'no_answer', due: null },
  { status: 'lost', attempts: 5, last: 'voicemail', due: null },
  { status: 'lost', attempts: 1, last: 'wrong_number', due: null },
  { status: 'dnc', attempts: 1, last: 'do_not_call', due: null },
  { status: 'lost', attempts: 2, last: 'not_interested', due: null },
  { status: 'contacted', attempts: 1, last: 'other', due: null, archived: 'archived from dialer' },
  { status: 'lost', attempts: 4, last: 'no_answer', due: null },
  { status: 'booked', attempts: 1, last: 'booked', due: null },
  { status: 'lost', attempts: 3, last: 'not_interested', due: null },
  { status: 'lost', attempts: 5, last: 'no_answer', due: null },
  { status: 'lost', attempts: 3, last: 'not_interested', due: null },
  { status: 'booked', attempts: 2, last: 'booked', due: null },
  { status: 'lost', attempts: 5, last: 'voicemail', due: null },
  { status: 'contacted', attempts: 3, last: 'voicemail', due: 'future' },
  { status: 'lost', attempts: 2, last: 'not_interested', due: null },
  { status: 'callback', attempts: 3, last: 'interested', due: 'future' },
  { status: 'lost', attempts: 4, last: 'no_answer', due: null },
  { status: 'dnc', attempts: 2, last: 'do_not_call', due: null },
  { status: 'won', attempts: 2, last: 'booked', due: null },
  { status: 'lost', attempts: 5, last: 'busy', due: null },
  { status: 'contacted', attempts: 2, last: 'no_answer', due: 'future' },
]

const SOUTH_PLAN: Plan[] = NORTH_PLAN.slice(0, 12).map((p, i) => (i % 3 === 2 ? { ...p, status: 'new', attempts: 0, last: null, due: null } : p))

export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name)
  if (!m) return 0
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0)
  return m[1] === '-' ? -minutes : minutes
}

// The instant a given day reads `hour:minute` in the leads' time zone.
export function atZoneTime(now: number, daysAgo: number, hour: number, minute: number): Date {
  const day = new Date(now - daysAgo * 86_400_000)
  const [y = 1970, mo = 1, d = 1] = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEMO_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(day)
    .split('-')
    .map(Number)
  const guess = Date.UTC(y, mo - 1, d, hour, minute)
  return new Date(guess - zoneOffsetMinutes(new Date(guess), DEMO_TIME_ZONE) * 60_000)
}

function isWeekend(date: Date): boolean {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: DEMO_TIME_ZONE, weekday: 'short' }).format(date)
  return day === 'Sat' || day === 'Sun'
}

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0')

export function formatPhone(e164: string | null): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 ?? '')
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 ?? '')
}

const RETRYABLE: Disposition[] = ['no_answer', 'voicemail', 'busy', 'hung_up']
const TALKED: Disposition[] = ['connected', 'interested', 'callback_later', 'booked', 'not_interested', 'do_not_call', 'hung_up']

function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/,? (llc|co\.)$/, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

type Line = [speaker: TranscriptLine['speaker'], at: number, text: string]

function conversation(kind: Disposition, who: { first: string; business: string; caller: string; company: string; issue: string }): Line[] {
  const { first, business, caller, company, issue } = who
  const companyEnd = company.endsWith('.') ? company : `${company}.`
  const opening: Line[] = [
    ['caller', 0, `Hi, is this ${first}?`],
    ['lead', 2.1, 'Yes, speaking.'],
    ['caller', 3.4, `${first}, this is ${caller}, from ${companyEnd} Quick honest question: is now a bad time for thirty seconds?`],
  ]
  switch (kind) {
    case 'booked':
      return [
        ...opening,
        ['lead', 9.8, 'I have a minute, go ahead.'],
        ['caller', 11.2, `Thanks. I'm calling about your website. ${issue}`],
        ['lead', 17.5, "Huh. Our nephew set it up years ago and nobody's touched it since."],
        ['caller', 22.9, `Would it be a bad idea if I sent you a short note on what I found, with a few ideas for ${business}?`],
        ['lead', 30.3, "No, that's fine. Send it to the front desk."],
        ['caller', 33.1, "Great. What's the best address?"],
        ['lead', 35.6, 'frontdesk at example dot com.'],
        ['caller', 38.2, "F-R-O-N-T-D-E-S-K at example dot com. You'll have it today. Could we look at it together Thursday at ten, your time?"],
        ['lead', 47.9, 'Thursday at ten works.'],
        ['caller', 50.1, `Thursday at ten. Thanks, ${first}.`],
      ]
    case 'interested':
      return [
        ...opening,
        ['lead', 9.5, 'Sure, what is it?'],
        ['caller', 11, `I'm calling about your website. ${issue}`],
        ['lead', 16.4, "Oh, I didn't know that. We get most of our customers from people looking us up."],
        ['caller', 22.7, 'Would it be a bad idea if I sent you a short note on what I found?'],
        ['lead', 27.1, 'Go ahead, send it over and call me next week.'],
      ]
    case 'callback_later':
      return [
        ...opening,
        ['lead', 9.2, "I'm with a customer right now. Can you call me after three?"],
        ['caller', 13.6, 'Of course. After three today. Thanks!'],
      ]
    case 'not_interested':
      return [
        ...opening,
        ['lead', 9.4, "Is this a sales call? We're all set, thanks."],
        ['caller', 12.8, 'No problem. Is it that things are fine, or just a busy week?'],
        ['lead', 16.1, "We're fine. Have a good one."],
      ]
    case 'hung_up':
      return [...opening, ['lead', 8.6, 'Not interested.']]
    case 'do_not_call':
      return [...opening, ['lead', 9.1, 'Please take me off your list.'], ['caller', 11.6, 'Of course. Sorry to bother you.']]
    case 'voicemail':
      return [
        ['lead', 0, `Hi, you've reached ${business}. We can't take your call right now. Please leave a message after the tone.`],
        ['caller', 9.4, `Hi ${first}, it's ${caller}, from ${companyEnd} I looked at your website today and I have one idea that could help. Call me back at this number. Thanks!`],
      ]
    default:
      return [
        ...opening,
        ['lead', 9.9, 'Okay, what is this about?'],
        ['caller', 11.4, `I'm calling about your website. ${issue}`],
        ['lead', 17.2, "Good to know. I'll mention it to the owner."],
      ]
  }
}

const ISSUE_LINE: Record<string, string> = {
  not_mobile: 'On my phone, I had to zoom in to read it.',
  no_https: 'When I open it, the browser says "Not Secure" up top.',
  site_down: "I tried it twice today and it didn't load.",
  outdated: 'The date at the bottom is a few years old.',
  parked_domain: 'Your address shows an ad page instead of your business.',
  no_form: 'The only way to reach you on it is to call.',
}

function transcriptOf(lines: Line[]): DemoCall['transcript'] {
  const tl = lines.map(([speaker, start, text]) => ({ speaker, start, text }))
  const label = (s: TranscriptLine['speaker']) => (s === 'caller' ? 'US' : s === 'ai' ? 'AI' : 'THEM')
  return {
    text: tl.map((l) => `[${label(l.speaker)}] ${l.text}`).join('\n'),
    lines: tl,
    model: 'Xenova/whisper-base.en',
    processingSeconds: Math.round(lines.length * 2.3 * 10) / 10,
  }
}

export function demoConversation(lead: DemoLead, caller: string, company: string, kind: Disposition): DemoCall['transcript'] {
  const first = lead.askForName?.split(' ')[0] ?? lead.ownerName?.split(' ')[0] ?? 'there'
  const issue = ISSUE_LINE[lead.siteIssues[0] ?? ''] ?? 'I looked at it on my phone today.'
  return transcriptOf(conversation(kind, { first, business: lead.businessName.replace(/,? (LLC|Co\.)$/, ''), caller, company, issue }))
}

export type DemoData = { leads: DemoLead[]; calls: DemoCall[] }

export function generateOrgData(org: DemoOrg, now: number): DemoData {
  const north = org.slug === 'north'
  const plan = north ? NORTH_PLAN : SOUTH_PLAN
  const rand = mulberry32(north ? 7 : 11)
  const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)]!
  const leads: DemoLead[] = []
  const calls: DemoCall[] = []
  let callSeq = 0

  plan.forEach((p, i) => {
    const nameIndex = north ? i : NAMES.length - 1 - i
    const [businessName, category] = NAMES[nameIndex % NAMES.length]!
    const [city, state, area] = PLACES[(i * 5 + (north ? 0 : 3)) % PLACES.length]!
    const phone = `+1${area}5550${100 + i + (north ? 0 : 50)}`
    const [ownerName, first] = PEOPLE[(i + (north ? 0 : 5)) % PEOPLE.length]!
    const issues = ISSUE_SETS[i % ISSUE_SETS.length]!
    const noSite = i % 9 === 4
    const website = noSite ? null : `https://${slugOf(businessName)}.example.com`
    const id = `${north ? '65a1' : '65b2'}c0de${hex(0, 12)}${hex(i, 4)}`
    const createdAt = new Date(now - (20 + (i % 9)) * 86_400_000)
    const rating = Math.round((3.6 + rand() * 1.4) * 10) / 10

    const lead: DemoLead = {
      orgId: org.id,
      claimed: true,
      id,
      phone,
      phoneDisplay: formatPhone(phone),
      businessName,
      website,
      bestEmail: i % 3 === 0 ? `${slugOf(businessName).split('-')[0]}@example.com` : null,
      ownerName: i % 4 === 3 ? null : ownerName,
      ownerLabel: i % 4 === 1 ? 'state filing' : null,
      askForName: i % 2 === 0 ? first : null,
      askForRole: i % 2 === 0 ? 'owner' : null,
      askForNote: i === 0 ? `Named in 9 reviews ("${first} was so helpful")` : null,
      address: `${100 + i * 7} Main St, ${city}, ${state}`,
      category,
      rating,
      reviewCount: 12 + Math.floor(rand() * 180),
      siteQualityScore: noSite ? null : 25 + Math.floor(rand() * 55),
      siteYear: issues.includes('outdated') ? 2015 + (i % 5) : null,
      sitePlatform: noSite ? null : pick(['WordPress', 'Wix', 'Squarespace', 'custom']),
      siteIssues: noSite ? [] : issues,
      hookSnippet: i === 2 ? `Checked live ${new Date(now - 2 * 86_400_000).toISOString().slice(0, 10)}: Your booking page shows an error instead of the calendar.` : null,
      googleMapsUrl: null,
      lane: noSite ? 'no-website' : 'web-audit',
      city,
      state,
      status: p.status,
      doNotCall: p.status === 'dnc',
      attempts: p.attempts,
      lastCalledAt: null,
      lastDisposition: p.last,
      lastDispositionLabel: p.last === 'other' ? 'gatekeeper, try the owner directly' : null,
      nextCallbackAt: null,
      notes: [],
      batch: i % 3 === 0 ? 'referrals' : i % 3 === 1 ? 'spring-list' : 'trade-show',
      archivedAt: p.archived ? new Date(now - 4 * 86_400_000).toISOString() : null,
      archivedReason: p.archived ?? null,
      createdAt: createdAt.toISOString(),
      recordingAllowed: DEMO_TRANSCRIBE_STATES.includes(state),
    }

    // Attempts spread back from a few days ago, each on a different hour of the calling window.
    let daysAgo = Math.min(13, 2 + p.attempts * 3 + (i % 3))
    for (let attempt = 1; attempt <= p.attempts; attempt++) {
      let start = atZoneTime(now, daysAgo, [9, 14, 10, 15, 11, 13][(attempt + i) % 6]!, Math.floor(rand() * 50))
      while (isWeekend(start)) start = new Date(start.getTime() - 86_400_000)
      const final = attempt === p.attempts
      const disposition: Disposition = final && p.last ? p.last : pick(RETRYABLE.slice(0, 3))
      const talked = TALKED.includes(disposition) || (disposition === 'other' && rand() > 0.3)
      const answered = talked || disposition === 'voicemail'
      const duration = disposition === 'voicemail' ? 18 + Math.floor(rand() * 25) : talked ? 35 + Math.floor(rand() * 180) : 0
      const caller = attempt % 3 === 0 ? org.callers[1]! : org.callers[0]!
      const sid = `CA${hex(north ? 0xa : 0xb, 1)}${hex(i, 3)}${hex(attempt, 2)}${hex(0, 26)}`
      const recordable = lead.recordingAllowed && answered
      const kind = disposition === 'other' ? 'connected' : disposition
      let transcript: DemoCall['transcript'] = null
      let transcriptError: DemoCall['transcriptError'] = null
      if (recordable && (talked || rand() > 0.35)) transcript = demoConversation(lead, caller.displayName, org.companyName, kind)
      else if (recordable) transcriptError = rand() > 0.5 ? { stage: 'too-short', message: 'the recording was under half a second' } : { stage: 'no-speech', message: 'no speech was heard on either side' }
      calls.push({
        id: `${north ? '66a1' : '66b2'}ca11${hex(0, 8)}${hex(callSeq++, 8)}`,
        orgId: org.id,
        direction: 'outbound',
        leadId: id,
        username: caller.username,
        attemptNumber: attempt,
        startedAt: start.toISOString(),
        answeredAt: answered ? new Date(start.getTime() + 6000).toISOString() : null,
        endedAt: new Date(start.getTime() + (duration + 8) * 1000).toISOString(),
        duration,
        dialStatus: answered ? 'completed' : disposition === 'busy' ? 'busy' : 'no-answer',
        disposition,
        dispositionLabel: lead.lastDispositionLabel && final ? lead.lastDispositionLabel : null,
        handledBy: null,
        inboundReason: null,
        fromNumber: null,
        parentCallSid: sid,
        aiSummary: null,
        transcript,
        transcriptError,
        quality: answered
          ? {
              avgMos: Math.round((3.9 + rand() * 0.5) * 10) / 10,
              outLossPct: Math.round(rand() * 12) / 10,
              maxOutLossPct: Math.round((1 + rand() * 3) * 10) / 10,
              voiceDb: Math.round((-27 + rand() * 6) * 10) / 10,
              voiceFloorDb: Math.round((-55 + rand() * 8) * 10) / 10,
              voicePeakDb: Math.round((-6 + rand() * 4) * 10) / 10,
              codec: 'opus',
              mic: 'USB Headset',
            }
          : null,
      })
      lead.lastCalledAt = start.toISOString()
      if (attempt === 1 && talked && disposition !== 'hung_up') {
        lead.notes.push({ body: `Spoke with ${first}. ${disposition === 'callback_later' ? 'Asked us to call back this afternoon.' : 'Friendly, open to a short note.'}`, author: caller.username, at: start.toISOString() })
      }
      daysAgo = Math.max(1, daysAgo - 3)
    }

    if (p.due === 'past') lead.nextCallbackAt = new Date(now - (240 - i * 7) * 60_000).toISOString()
    if (p.due === 'future') lead.nextCallbackAt = new Date(now + (2 + (i % 3)) * 86_400_000).toISOString()
    if (i === 0) lead.notes.push({ body: 'Left a voicemail. Opens at 7am; best before 10.', author: org.callers[0]!.username, at: lead.lastCalledAt ?? createdAt.toISOString() })
    if (p.status === 'lost' && p.last && RETRYABLE.includes(p.last)) {
      lead.notes.push({ body: `Auto-closed after ${p.attempts} attempts without a result.`, author: 'system', at: lead.lastCalledAt ?? createdAt.toISOString() })
    }
    leads.push(lead)
  })

  calls.push(...inboundCalls(org, leads, now))
  return { leads, calls }
}

function inboundCalls(org: DemoOrg, leads: DemoLead[], now: number): DemoCall[] {
  const person = org.callers[0]!.displayName
  const ai = (lines: [TranscriptLine['speaker'], number, string][]) => transcriptOf(lines)
  const byIndex = (i: number) => leads[i % leads.length]!
  const firstOf = (i: number) => byIndex(i).ownerName?.split(' ')[0] ?? byIndex(i).askForName ?? 'Sam'
  const [tom, nina, luis] = [firstOf(4), firstOf(9), firstOf(30)]
  const rows: Array<{ lead: DemoLead | null; from: string; daysAgo: number; hour: number; handledBy: InboundHandler; duration: number; reason: string | null; summary: AiSummary | null; lines: Line[] | null }> = [
    {
      lead: byIndex(4),
      from: byIndex(4).phone,
      daysAgo: 1,
      hour: 16,
      handledBy: 'ai',
      duration: 74,
      reason: 'completed',
      summary: { name: tom, business: byIndex(4).businessName, bestTime: 'tomorrow before 11am', reason: 'returning our call about the website', flags: [] },
      lines: [
        ['ai', 0, `Hi, this is Ava, ${person}'s AI assistant at Acme Co. ${person} can't pick up right now. Who am I speaking with?`],
        ['lead', 6.2, `Hi, this is ${tom} from ${byIndex(4).businessName}. Somebody called me yesterday about our website.`],
        ['ai', 11.8, `Thanks for calling back, ${tom}. I'll pass a written note of this call to ${person} so they have everything. What's the best time for a call back?`],
        ['lead', 19.4, 'Tomorrow morning, before eleven.'],
        ['ai', 22.1, 'Is the number you are calling from the best one to reach you?'],
        ['lead', 25.6, 'Yes, this is my cell.'],
        ['ai', 27.9, `Got it: ${tom}, tomorrow before eleven at this number. ${person} will call you then. Goodbye!`],
      ],
    },
    {
      lead: byIndex(9),
      from: byIndex(9).phone,
      daysAgo: 2,
      hour: 12,
      handledBy: 'ai',
      duration: 96,
      reason: 'completed',
      summary: { name: nina, business: byIndex(9).businessName, bestTime: 'Friday afternoon', reason: 'wants to know what it would cost', email: `${nina.toLowerCase()}@example.com`, flags: ['wants_price'] },
      lines: [
        ['ai', 0, `Hi, this is Ava, ${person}'s AI assistant at Acme Co. ${person} can't pick up right now. Who am I speaking with?`],
        ['lead', 5.4, `It's ${nina}. I got a note from you guys and wanted to ask what something like that costs.`],
        ['ai', 11.2, `Good question, ${nina}. I'll pass a written note of this call to ${person}, and they'll go over pricing on the call back. When suits you?`],
        ['lead', 19.8, 'Friday afternoon is best.'],
        ['ai', 22.5, 'Would you like a summary by email too?'],
        ['lead', 25.1, `Sure. It's ${nina.toLowerCase()} at example dot com.`],
        ['ai', 29.3, `${nina.toUpperCase().split('').join('-')} at example dot com. Thanks, ${nina}. Talk soon!`],
      ],
    },
    { lead: byIndex(2), from: byIndex(2).phone, daysAgo: 3, hour: 10, handledBy: 'human', duration: 142, reason: null, summary: null, lines: null },
    {
      lead: null,
      from: '+14045550177',
      daysAgo: 3,
      hour: 15,
      handledBy: 'ai',
      duration: 31,
      reason: 'completed',
      summary: { name: 'Kim', business: 'Parkside Bistro', reason: 'heard about Acme from a friend', bestTime: 'any weekday morning', flags: ['not_a_lead'] },
      lines: [
        ['ai', 0, `Hi, this is Ava, ${person}'s AI assistant at Acme Co. ${person} can't pick up right now. Who am I speaking with?`],
        ['lead', 5.9, "Hi, I'm Kim from Parkside Bistro. A friend gave me your number."],
        ['ai', 10.4, `Lovely, Kim. I'll pass a written note of this call to ${person}. When is a good time for a call back?`],
        ['lead', 16.2, 'Any weekday morning.'],
      ],
    },
    { lead: byIndex(12), from: byIndex(12).phone, daysAgo: 5, hour: 17, handledBy: 'missed', duration: 7, reason: 'caller_hung_up_ringing', summary: null, lines: null },
    {
      lead: byIndex(30),
      from: byIndex(30).phone,
      daysAgo: 6,
      hour: 11,
      handledBy: 'ai',
      duration: 22,
      reason: 'completed',
      summary: { name: luis, reason: 'asked not to be called again', flags: ['do_not_call'] },
      lines: [
        ['ai', 0, `Hi, this is Ava, ${person}'s AI assistant at Acme Co. ${person} can't pick up right now. Who am I speaking with?`],
        ['lead', 5.1, 'Please take my number off your list.'],
        ['ai', 8.3, "I'm sorry for the bother. You won't be called again. Goodbye."],
      ],
    },
    { lead: byIndex(7), from: byIndex(7).phone, daysAgo: 8, hour: 9, handledBy: 'missed', duration: 0, reason: 'daily_budget', summary: null, lines: null },
    { lead: byIndex(15), from: byIndex(15).phone, daysAgo: 9, hour: 14, handledBy: 'human', duration: 205, reason: null, summary: null, lines: null },
  ]

  return rows.map((r, i) => {
    const start = atZoneTime(now, r.daysAgo, r.hour, 7 + i * 6)
    return {
      id: `${org.slug === 'north' ? '67a1' : '67b2'}1b0d${hex(0, 8)}${hex(i, 8)}`,
      orgId: org.id,
      direction: 'inbound' as const,
      leadId: r.lead?.id ?? null,
      username: null,
      attemptNumber: null,
      startedAt: start.toISOString(),
      answeredAt: r.handledBy === 'missed' ? null : start.toISOString(),
      endedAt: new Date(start.getTime() + r.duration * 1000).toISOString(),
      duration: r.duration,
      dialStatus: r.handledBy === 'missed' ? 'no-answer' : 'completed',
      disposition: null,
      dispositionLabel: null,
      handledBy: r.handledBy,
      inboundReason: r.reason,
      fromNumber: r.from,
      parentCallSid: `CA${hex(0xd, 1)}${hex(i, 3)}${hex(0, 28)}`,
      aiSummary: r.summary,
      transcript: r.lines ? { ...ai(r.lines)!, model: 'azure-voice-live', processingSeconds: null } : null,
      transcriptError: null,
      quality: null,
    }
  })
}
