import type { Lead } from '../types'

/**
 * Per-lead call guide. The engine picks ONE talking point per lead from what the lead
 * record says (the most concrete finding first), fills in the caller's own name, the
 * workspace's company and its callback number, and alternates two openers by lead id.
 * The words are a neutral template for the demo company: replace them with your own.
 */

export type Objection = { they: string; you: string[] }
export type OpenerVariant = 'A' | 'B'
export type CallMode = 'cold' | 'warm' | 'followup'

type SegmentKey = 'site_down' | 'parked_domain' | 'not_mobile' | 'no_https' | 'no_website' | 'outdated' | 'no_form' | 'general'

type Ctx = {
  business: string
  first: string | null
  domain: string
  stars: string | null
  year: number | null
}

type Segment = {
  label: string
  check: string
  firstLine: string
  next: string[]
  microYes: string
  askExtra?: string
  objections: Objection[]
  voicemailProblem: string
}

// Undeniable beats arguable: a site that won't open can't be explained away, a missing form can.
const ISSUE_PRIORITY: Array<[issue: string, segment: SegmentKey]> = [
  ['site_down', 'site_down'],
  ['parked_domain', 'parked_domain'],
  ['not_mobile', 'not_mobile'],
  ['mobile_overflow', 'not_mobile'],
  ['no_https', 'no_https'],
  ['outdated', 'outdated'],
  ['no_form', 'no_form'],
]

const SEGMENTS: Record<SegmentKey, (c: Ctx) => Segment> = {
  site_down: (c) => ({
    label: 'Site down',
    check: `Open ${c.domain} on your phone. Mention it only if it failed twice today, an hour apart.`,
    firstLine: "I tried your website twice today and it didn't load.",
    next: ['Thought you would want to know.', '(stop and let them answer)'],
    microYes: 'Do you know who looks after it?',
    objections: [
      { they: 'It works for me', you: ['Could be my side. Could you check it on your phone now?', "(don't argue)"] },
      { they: "We know, it's being fixed", you: ["Good. How long has it been down?", '(a vague answer is the opening)'] },
    ],
    voicemailProblem: "it didn't load",
  }),

  parked_domain: (c) => ({
    label: 'Parked domain',
    check: `Open ${c.domain} on your phone. An ad page or a "for sale" page? Then say it.`,
    firstLine: `I typed in ${c.domain}, and it shows an ad page instead of your business.`,
    next: ['Did you know about that?'],
    microYes: `Is ${c.domain} still yours?`,
    objections: [{ they: "That's not mine anymore", you: ["Got it. Then people who look you up find no site at all."] }],
    voicemailProblem: 'your web address shows an ad page instead of your business',
  }),

  not_mobile: (c) => ({
    label: 'Hard to use on a phone',
    check: `Open ${c.domain} on your phone. Had to zoom in or scroll sideways? Then say it.`,
    firstLine: 'On my phone, I had to zoom in to read your site.',
    next: ['Most people looking you up are on a phone.'],
    microYes: 'Have you looked at it on your own phone lately?',
    objections: [
      { they: 'It looks fine to me', you: ['Could be. Can you open it now, while we talk?', '(then stay quiet and let them try)'] },
    ],
    voicemailProblem: 'I had to zoom in to read it on my phone',
  }),

  no_https: (c) => ({
    label: '"Not Secure" warning',
    check: `Open ${c.domain} in Chrome on your phone. See "Not Secure"? Then say it.`,
    firstLine: 'When I open your site, the browser says "Not Secure" up top.',
    next: ["That's the browser's label, not mine."],
    microYes: 'Did anyone ever mention that to you?',
    objections: [
      { they: 'Did I get hacked?', you: ["No, nothing like that. The site just isn't using the secure setting.", "It's an easy fix."] },
    ],
    voicemailProblem: 'the browser shows "Not Secure" on it',
  }),

  no_website: (c) => ({
    label: 'No website',
    check: `Search ${c.business} on a map app. Still no website link? Then say it.`,
    firstLine: c.stars ? `You've got ${c.stars} online, but no website.` : "You're listed online, but there's no website behind it.",
    next: ["So people find you, like what they read, and then there's nowhere to go."],
    microYes: 'Have you ever had a site, or has it always been phone and referrals?',
    objections: [
      { they: 'I get all my work from referrals', you: ['Best kind of work.', 'When a friend gives them your name, they look you up. What do they find?'] },
    ],
    voicemailProblem: c.stars ? `you have ${c.stars} online but no website` : 'you have no website behind your listing',
  }),

  outdated: (c) => ({
    label: 'Outdated',
    check: `Scroll to the bottom of ${c.domain} on your phone. Is the year ${c.year ?? 'old'}?`,
    firstLine: c.year ? `The bottom of your site still says ${c.year}.` : 'The date at the bottom of your site is a few years old.',
    next: ["Most people won't notice. The ones who do wonder if you're still open."],
    microYes: 'When did someone last update it?',
    objections: [{ they: 'So what? It works', you: [`It does. It just doesn't show the work you've done since ${c.year ?? 'then'}.`] }],
    voicemailProblem: 'the date at the bottom is a few years old',
  }),

  no_form: (c) => ({
    label: 'No contact form',
    check: `Open ${c.domain} on your phone. Only a phone number, no form? Then say it.`,
    firstLine: 'On your site, the only way to reach you is to call.',
    next: ["Some people won't call a stranger; they'd rather send a message."],
    microYes: 'Do people ever text you instead of calling?',
    askExtra: 'With a simple form that sends you their name and number.',
    objections: [{ they: 'I want them to call', you: ["You'd still call them. The form just gives you the number."] }],
    voicemailProblem: 'the only way to reach you on it is to call',
  }),

  general: (c) => ({
    label: 'Check the site yourself',
    check: `Nothing on record is worth saying. Open ${c.domain} on your phone and pick ONE thing you see.`,
    firstLine: 'I looked at your site on my phone today.',
    next: ['(say the one thing you saw, in one short sentence)'],
    microYes: 'Have you looked at it on your own phone lately?',
    objections: [],
    voicemailProblem: 'I have one idea for it',
  }),
}

const SHARED_OBJECTIONS: Objection[] = [
  {
    they: 'Not interested',
    you: ['No problem. Is it that things are fine, or just a busy week?', '(fine: polite exit. Busy: "When is a better time?")'],
  },
  { they: 'How did you get my number?', you: ['From your public business listing.'] },
  { they: 'Send me an email', you: ["Happy to. What's the best address?", '(spell it back letter by letter)'] },
  { they: 'Is this a robot?', you: ["No, I'm a real person: {caller}, from {company}, calling about your website."] },
  { they: "I'm busy right now", you: ["I'll let you go. When is a better time today?", '(get a real time. "Later" is a no.)'] },
  { they: 'Take me off your list', you: ['Of course. Sorry to bother you.', '>>> Hang up and mark DO NOT CALL. No second try, ever. <<<'] },
]

const FOLLOWUP_OBJECTIONS: Objection[] = [
  { they: 'Let me think about it', you: ["Of course. What's the part you're unsure about?", '(answer that, then) Can I call you {day} at {time}?'] },
]

const CLOSE = [
  'Email or text, which do you check more?',
  '(spell the email back letter by letter)',
  "You'll have it today.",
  'Can we look at it together for ten minutes, {day} at {time}, your time?',
  '(say the day and time twice, then set the callback in the app)',
]

const WHY_CALL = ["It's a short look at what we found, so you can decide for yourself.", "If it isn't useful, there's no follow-up."]

const LINE_BREAKS = [
  'Never "Can you hear me?"',
  'Say: "Sorry, my line cut out for a second." Then the shortest version of your last line.',
  'Two "what?"s in a row: "Bad line today, can I call you right back?"',
  'After they stop talking, count "one" in your head before you speak (the line has a delay).',
] as const

const NEVER_SAY = [
  'A past client, a testimonial or a result you cannot show.',
  'A website problem you did not see yourself today.',
  'That you are local, or calling on behalf of anyone else.',
  'Anything after "take me off your list": mark do-not-call and hang up.',
] as const

export type ResolvedScript = {
  segment: SegmentKey
  label: string
  mode: CallMode
  variant: OpenerVariant
  check: string
  opener: string[]
  firstLine: string
  next: string[]
  microYes: string
  ask: string[]
  close: string[]
  whyCall: string[]
  objections: Objection[]
  voicemail: string
  gatekeeper: string[]
  lineBreaks: readonly string[]
  neverSay: readonly string[]
  secondaryIssues: string[]
}

export function spokenFirstName(ownerName: string | null): string | null {
  const first = ownerName?.trim().split(/\s+/)[0]
  // Initials ("W K Graham") can't be said as a name; the "owner of" greeting is safer.
  if (!first || !/^[A-Za-z][A-Za-z'-]+$/.test(first)) return null
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

// "Acme Co." already ends a sentence; another period would read "Acme Co..".
const endSentence = (text: string) => (text.endsWith('.') ? text : `${text}.`)

function hostOf(website: string | null): string {
  if (!website) return 'your website'
  try {
    return new URL(website).hostname.replace(/^www\./, '')
  } catch {
    return website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || 'your website'
  }
}

// "Cedar Dental, LLC" is how the state registers it, not how anyone says it.
export function spokenBusiness(name: string): string {
  return name.replace(/[,\s]+(l\.?l\.?c\.?|inc\.?|co\.?|corp\.?|ltd\.?)$/i, '').trim() || name
}

// The name customers use in reviews is usually who picks up, so it beats a registry name,
// unless reviews only name a staff member and we already know the owner.
export function firstToAskFor(lead: Pick<Lead, 'ownerName' | 'askForName' | 'askForRole'>): string | null {
  const owner = spokenFirstName(lead.ownerName)
  const ask = spokenFirstName(lead.askForName)
  if (ask && (lead.askForRole !== 'staff' || !owner)) return ask
  return owner
}

function contextOf(lead: Lead): Ctx {
  const hasStars = lead.rating != null && lead.rating >= 4 && (lead.reviewCount ?? 0) >= 3
  return {
    business: spokenBusiness(lead.businessName),
    first: firstToAskFor(lead),
    domain: hostOf(lead.website),
    stars: hasStars ? `${lead.rating} stars` : null,
    year: lead.siteYear,
  }
}

export function segmentOf(lead: Lead): SegmentKey {
  if (!lead.website) return 'no_website'
  const hit = ISSUE_PRIORITY.find(([issue]) => lead.siteIssues.includes(issue))
  return hit ? hit[1] : 'general'
}

// Alternates by lead, not by day, so time of day can't skew the A/B test. Deterministic from
// the id, so the variant any past call used can be recomputed from its lead id.
export function openerVariant(leadId: string): OpenerVariant {
  return parseInt(leadId.slice(-1), 16) % 2 === 0 ? 'A' : 'B'
}

export function defaultMode(lead: Lead, calledUs: boolean): CallMode {
  if (calledUs || lead.status === 'callback' || lead.lastDisposition === 'callback_later') return 'warm'
  return 'cold'
}

// Import batches can carry a line someone verified by hand ("Checked live 2026-10-02: ...").
// Anything else in hookSnippet is imported page text, never spoken.
export function verifiedHook(lead: Lead): { date: string; line: string } | null {
  const m = lead.hookSnippet?.match(/^Checked live (\d{4}-\d{2}-\d{2}):\s*(.+)$/s)
  return m?.[1] && m[2] ? { date: m[1], line: m[2].trim() } : null
}

function problemLine(lead: Lead, seg: Segment): { line: string; check: string } {
  const verified = verifiedHook(lead)
  if (!verified) return { line: seg.firstLine, check: seg.check }
  return { line: verified.line, check: `Checked live on ${verified.date}. Open it on your phone again today before you say it.` }
}

export function openingHook(lead: Lead): { line: string; check: string; label: string } {
  const seg = SEGMENTS[segmentOf(lead)](contextOf(lead))
  return { ...problemLine(lead, seg), label: seg.label }
}

function spokenNumber(e164: string | null | undefined): string | null {
  const digits = e164?.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  if (!digits || digits.length !== 10) return null
  const d = digits.split('')
  return `${d.slice(0, 3).join('-')} … ${d.slice(3, 6).join('-')} … ${d.slice(6).join('-')}`
}

export function resolveScript(
  lead: Lead,
  opts: { callerName: string; companyName: string; mode: CallMode; callbackNumber?: string | null },
): ResolvedScript {
  const c = contextOf(lead)
  const segment = segmentOf(lead)
  const seg = SEGMENTS[segment](c)
  const problem = problemLine(lead, seg)
  const caller = opts.callerName
  const company = opts.companyName
  const variant = openerVariant(lead.id)
  const about = segment === 'no_website' ? `${c.business} online` : 'your website'
  const hi = `Hi${c.first ? ` ${c.first}` : ''}`

  const greeting = c.first
    ? [`Hi, is this ${c.first}?`, `(wait for the yes. Unsure how to say "${c.first}"? Use: "Hi, am I speaking with the owner of ${c.business}?")`]
    : [`Hi, am I speaking with the owner of ${c.business}?`, '(wait for the yes)']
  const intro = c.first ? `${c.first} … this is ${caller}, from ${endSentence(company)}` : `This is ${caller}, from ${endSentence(company)}`

  let opener: string[]
  if (opts.mode === 'warm') {
    opener = [
      `${hi}, it's ${caller}, from ${endSentence(company)}`,
      '(they called us:) Returning your call. Thanks for calling back.',
      '(they asked us to call back:) You asked me to call back about now.',
      `I called you about ${about}.`,
      'Do you have two minutes now?',
    ]
  } else if (opts.mode === 'followup') {
    opener = [
      `${hi}, ${caller} from ${company}, about ${about}.`,
      '{On Monday} you asked me to send what I had in mind. It is ready.',
      '(say that ONLY if it is actually ready)',
      'Can I walk you through it for ten minutes?',
    ]
  } else if (variant === 'A') {
    opener = [
      ...greeting,
      intro,
      'Quick honest question: is now a bad time for thirty seconds?',
      '(wait. If yes: "No problem. When\'s a better time?")',
      `Thanks. … I'm calling about ${about}.`,
    ]
  } else {
    opener = [...greeting, intro, `I'm calling about ${about}.`]
  }

  const ask =
    opts.mode === 'followup'
      ? ['Would it be a bad idea to look at it together, {day} at {time}, your time?']
      : [
          `Would it be a bad idea if I sent you a short note on what I found, with a few ideas for ${c.business}?`,
          ...(seg.askExtra ? [seg.askExtra] : []),
        ]

  const number = spokenNumber(opts.callbackNumber)
  const voicemail =
    `${hi}, it's ${caller}, from ${endSentence(company)} … ` +
    `I looked at ${about} today, and ${seg.voicemailProblem}. … ` +
    'I have one idea that could help. … ' +
    (number ? `Call me back at ${number}. Again: ${number}.` : 'Call me back at this number.')

  const gatekeeper = [
    `Hi, this is ${caller}, from ${endSentence(company)}`,
    `I'm calling about ${about}. Who looks after that?`,
    `Is ${c.first ?? 'the owner'} around?`,
    "(not around:) When's a good time to catch them? Get a real time, or an email address.",
  ]

  const fill = (t: string) => t.replace(/\{caller\}/g, caller).replace(/\{company\}/g, company)
  const objections =
    opts.mode === 'followup'
      ? [...FOLLOWUP_OBJECTIONS, ...SHARED_OBJECTIONS.filter((o) => /Take me off/.test(o.they))]
      : [...seg.objections, ...SHARED_OBJECTIONS]

  return {
    segment,
    label: seg.label,
    mode: opts.mode,
    variant,
    check: problem.check,
    opener,
    firstLine: problem.line,
    next: seg.next,
    microYes: seg.microYes,
    ask,
    close: CLOSE,
    whyCall: WHY_CALL,
    objections: objections.map((o) => ({ they: o.they, you: o.you.map(fill) })),
    voicemail,
    gatekeeper,
    lineBreaks: LINE_BREAKS,
    neverSay: NEVER_SAY,
    secondaryIssues: lead.siteIssues.filter((i) => !ISSUE_PRIORITY.some(([issue, s]) => s === segment && issue === i)),
  }
}
