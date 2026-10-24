export type Role = 'owner' | 'caller'

export type User = { id: string; username: string; displayName: string }

// The workspace this tab acts in. Every request carries its id (X-Org).
export type Org = { id: string; name: string; role: Role; companyName: string }

export type OrgSummary = { id: string; name: string; role: Role }

// `orgs` is only the signed-in user's own workspaces; a caller normally has one.
export type Session = { user: User; org: Org; orgs: OrgSummary[] }

export type OrgSetup = {
  workspace: string
  twilioConfigured: boolean
  callerId: string | null
  callWindow: CallWindow
  voiceWebhookUrl: string | null
}

export type Note = { body: string; author: string; at: string }

export type LeadStatus = 'new' | 'contacted' | 'callback' | 'booked' | 'won' | 'lost' | 'dnc'

export type Disposition =
  | 'connected'
  | 'voicemail'
  | 'no_answer'
  | 'busy'
  | 'wrong_number'
  | 'not_interested'
  | 'callback_later'
  | 'interested'
  | 'booked'
  | 'do_not_call'
  | 'hung_up'
  | 'other'

export type Lead = {
  id: string
  phone: string
  phoneDisplay: string
  businessName: string
  website: string | null
  bestEmail: string | null
  ownerName: string | null
  ownerLabel: string | null
  askForName: string | null
  askForRole: string | null
  askForNote: string | null
  address: string | null
  category: string | null
  rating: number | null
  reviewCount: number | null
  siteQualityScore: number | null
  siteYear: number | null
  sitePlatform: string | null
  siteIssues: string[]
  hookSnippet: string | null
  googleMapsUrl: string | null
  lane: string | null
  city: string | null
  state: string | null
  status: LeadStatus
  doNotCall: boolean
  attempts: number
  lastCalledAt: string | null
  lastDisposition: Disposition | null
  lastDispositionLabel: string | null
  nextCallbackAt: string | null
  notes: Note[]
  batch: string | null
  archivedAt: string | null
  archivedReason: string | null
  createdAt: string | null
  recordingAllowed: boolean
  // Owner only: present when the lead moved between workspaces.
  recycledFrom?: { orgId: string; at: string } | null
  recycle?: { to: string; state: 'pending' | 'done'; at: string } | null
}

export type LeadView = 'queue' | 'archived' | 'all' | 'recyclable'

export type LeadFilters = {
  view?: LeadView
  search?: string
  status?: string
  lane?: string
  batch?: string
  city?: string
  state?: string
  issue?: string
  hasEmail?: string
  minAttempts?: string
  maxAttempts?: string
  olderThanDays?: string
  notCalledSinceDays?: string
  limit?: number
  offset?: number
}

export type Facets = {
  cities: string[]
  states: string[]
  lanes: string[]
  batches: string[]
  issues: string[]
  statuses: { status: string; count: number }[]
  archivedCount: number
  total: number
}

export type TranscriptLine = {
  speaker: 'caller' | 'lead' | 'ai'
  start: number
  end?: number
  text: string
}

export type Transcript = {
  text: string
  lines: TranscriptLine[]
  model: string | null
}

export type CallDirection = 'outbound' | 'inbound'
export type InboundHandler = 'human' | 'ai' | 'missed'

export type TranscriptSort = 'startedAt' | 'business' | 'caller' | 'attempt' | 'duration' | 'outcome'

export type TranscriptQuery = {
  search?: string
  real?: string
  outcome?: string
  caller?: string
  direction?: string
  minSeconds?: string
  days?: string
  status?: string
  sort: TranscriptSort
  dir: 'asc' | 'desc'
  limit: number
  offset: number
}

export type TranscriptRow = {
  id: string
  startedAt: string
  duration: number
  direction: CallDirection
  handledBy: InboundHandler | null
  username: string | null
  attemptNumber: number | null
  disposition: Disposition | null
  dispositionLabel: string | null
  businessName: string | null
  phone: string | null
  lineCount: number
  snippet: { speaker: TranscriptLine['speaker'] | null; text: string } | null
  error: { stage: string; message: string | null } | null
}

export type TranscriptPage = {
  total: number
  offset: number
  limit: number
  callers: string[]
  rows: TranscriptRow[]
}

export type TranscriptDetail = Omit<TranscriptRow, 'lineCount' | 'snippet'> & {
  leadId: string | null
  place: string | null
  answeredAt: string | null
  aiSummary: AiSummary | null
  transcript: (Transcript & { processingSeconds: number | null }) | null
  quality: {
    avgMos: number | null
    outLossPct: number | null
    maxOutLossPct: number | null
    voiceDb: number | null
    voiceFloorDb: number | null
    voicePeakDb: number | null
    codec: string | null
    mic: string | null
  } | null
}

export type CallbackSort = 'startedAt' | 'business' | 'handledBy' | 'duration' | 'status'

export type CallbackQuery = {
  search?: string
  handledBy?: string
  who?: string
  days?: string
  sort: CallbackSort
  dir: 'asc' | 'desc'
  limit: number
  offset: number
}

export type CallbackRow = {
  id: string
  startedAt: string
  duration: number
  handledBy: InboundHandler
  reason: string | null
  phone: string | null
  isTest: boolean
  timesCalled: number
  lead: {
    id: string
    businessName: string | null
    ownerName: string | null
    place: string | null
    status: LeadStatus | null
    doNotCall: boolean
  } | null
  aiSummary: AiSummary | null
  ourCalls: number
  lastOutbound: {
    startedAt: string
    disposition: Disposition | null
    dispositionLabel: string | null
    username: string | null
  } | null
  snippet: string | null
  hasTranscript: boolean
}

export type CallbackPage = {
  total: number
  offset: number
  limit: number
  leadTimeZone: string
  rows: CallbackRow[]
}

export type AiSummary = {
  name?: string
  business?: string
  callbackNumber?: string
  bestTime?: string
  reason?: string
  email?: string
  notes?: string
  flags: string[]
}

export type CallHistoryEntry = {
  id: string
  attemptNumber: number | null
  startedAt: string
  answeredAt: string | null
  duration: number
  dialStatus: string | null
  disposition: Disposition | null
  dispositionLabel: string | null
  username: string | null
  direction: CallDirection
  handledBy: InboundHandler | null
}

export type LeadDetail = { lead: Lead; calls: CallHistoryEntry[] }

export type CallWindow = {
  open: boolean
  reason: string
  leadLocalTime: string
  leadTimeZone: string
}

export type QueueResponse = {
  callWindow: CallWindow
  callerName: string
  callbackNumber: string | null
  companyName: string
  total: number
  offset: number
  limit: number
  leads: Lead[]
}

export type CallStatus = {
  callSid: string
  dialStatus: string | null
  answeredAt: string | null
  endedAt: string | null
  duration: number
}

export type ImportResult = {
  batch: string
  totalRows: number
  imported: number
  updated: number
  skippedNoPhone: number
  skippedBadPhone: number
  duplicatesInFile: number
  skippedOwnedElsewhere: number
  skippedDoNotCall: number
  errors: string[]
}

export type StatsOverview = {
  days: number
  totalLeads: number
  summary: {
    calls: number
    talked: number
    voicemail: number
    notReached: number
    unlabeled: number
    talkRate: number
    talkSeconds: number
    estimatedCostUsd: number
  }
  byDay: { date: string; calls: number; talked: number; voicemail: number; talkSeconds: number }[]
  byHour: { hour: number; calls: number; talked: number; voicemail: number }[]
  byAttempt: { attempt: number; calls: number; talked: number; voicemail: number }[]
  byDisposition: { disposition: string; count: number }[]
  byStatus: { status: string; count: number }[]
  byCaller: { username: string; calls: number; talked: number; talkSeconds: number }[]
  inbound: { total: number; ai: number; human: number; missed: number; aiSeconds: number }
}
