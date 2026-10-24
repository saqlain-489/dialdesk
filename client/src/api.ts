import type {
  CallbackPage,
  CallbackQuery,
  CallStatus,
  CallWindow,
  Disposition,
  Facets,
  ImportResult,
  Lead,
  LeadFilters,
  LeadDetail,
  OrgSetup,
  QueueResponse,
  Session,
  StatsOverview,
  TranscriptDetail,
  TranscriptLine,
  TranscriptPage,
  TranscriptQuery,
} from './types'

export type CallQuality = {
  samples: number
  avgMicLevel: number
  silentMicPct: number
  // Loss, MOS and jitter here are the lead's audio reaching us (the SDK reads inbound-rtp).
  maxPacketLossPct: number
  avgPacketLossPct: number
  avgMos: number | null
  maxRttMs: number
  avgJitterMs: number
  warnings: string[]
  // Our voice reaching Twilio, from its RTCP reports: what the lead actually hears.
  outLossPct: number | null
  maxOutLossPct: number | null
  avgOutJitterMs: number | null
  // Our voice as sent, dBFS: the loudest tenth of seconds (talking), the quietest tenth (gaps), and the peak (0 = clipping).
  voiceDb: number | null
  voiceFloorDb: number | null
  voicePeakDb: number | null
  codec: string | null
  edge: string | null
  mic: {
    label: string
    autoGainControl: boolean | null
    echoCancellation: boolean | null
    noiseSuppression: boolean | null
  } | null
  // Seconds relative to the answer; negative = while ringing.
  warningEvents: { name: string; at: number; cleared: boolean }[]
}

// Set once the session is known. The cookie is shared by every tab, so the server checks
// this against it and answers 409 if another tab has switched workspace since.
let activeOrgId: string | null = null

export function setActiveOrg(orgId: string | null): void {
  activeOrgId = orgId
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }
  if (activeOrgId) headers['X-Org'] = activeOrgId
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers,
    ...init,
  })

  if (res.status === 409) {
    const body = (await res.clone().json().catch(() => ({}))) as { error?: string }
    if (body.error === 'org_changed') {
      window.location.reload()
      throw new Error('This tab was on another workspace. Reloading…')
    }
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string }
    throw new Error(body.detail || body.error || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  health: () => request<{ ok: boolean; publicUrl: string; callWindow: CallWindow }>('/api/health'),

  me: () => request<Session>('/api/auth/me'),

  login: (username: string, password: string) =>
    request<Session>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  switchOrg: (orgId: string) =>
    request<Session>('/api/auth/switch-org', { method: 'POST', body: JSON.stringify({ orgId }) }),

  orgSetup: () => request<OrgSetup>('/api/org/setup'),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  queue: (params: LeadFilters = {}) => {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') qs.set(key, String(value))
    }
    return request<QueueResponse>(`/api/leads/queue?${qs}`)
  },

  facets: () => request<Facets>('/api/leads/facets'),

  archiveLead: (leadId: string, reason?: string) =>
    request<{ lead: Lead }>(`/api/leads/${leadId}/archive`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  restoreLead: (leadId: string) =>
    request<{ lead: Lead }>(`/api/leads/${leadId}/restore`, { method: 'POST' }),

  deleteLead: (leadId: string) =>
    request<{ deleted: true; callsDeleted: number }>(`/api/leads/${leadId}`, { method: 'DELETE' }),

  bulkArchive: (filter: LeadFilters, expectedCount: number, reason?: string) =>
    request<{ archived: number }>('/api/leads/bulk-archive', {
      method: 'POST',
      body: JSON.stringify({ filter, expectedCount, reason }),
    }),

  recycleLead: (leadId: string, orgId: string) =>
    request<{ recycled: number }>(`/api/leads/${leadId}/recycle`, {
      method: 'POST',
      body: JSON.stringify({ orgId }),
    }),

  bulkRecycle: (filter: LeadFilters, expectedCount: number, orgId: string) =>
    request<{ recycled: number; skipped: number }>('/api/leads/bulk-recycle', {
      method: 'POST',
      body: JSON.stringify({ filter, expectedCount, orgId }),
    }),

  batches: () => request<{ batches: { batch: string; count: number }[] }>('/api/leads/batches'),

  leadDetail: (leadId: string) => request<LeadDetail>(`/api/leads/${leadId}`),

  disposition: (
    leadId: string,
    body: { disposition: Disposition; dispositionLabel?: string; note?: string; callbackAt?: string; callSid?: string },
  ) =>
    request<{ lead: Lead }>(`/api/leads/${leadId}/disposition`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  updateLead: (leadId: string, body: { status?: string; doNotCall?: boolean; note?: string }) =>
    request<{ lead: Lead }>(`/api/leads/${leadId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  twilioToken: () =>
    request<{ token: string; identity: string; expiresInSeconds: number }>('/api/twilio-token'),

  callStatus: (sid: string) => request<CallStatus>(`/api/calls/${sid}`),

  saveCallQuality: (sid: string, body: CallQuality) =>
    request<{ ok: true }>(`/api/calls/${sid}/quality`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  reportTranscriptError: (sid: string, body: { stage: string; message?: string }) =>
    request<{ ok: true }>(`/api/calls/${sid}/transcript-error`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  saveTranscript: (
    sid: string,
    body: { text: string; lines: TranscriptLine[]; model: string; processingSeconds: number },
  ) =>
    request<{ ok: true; lines: number }>(`/api/calls/${sid}/transcript`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  transcripts: (query: TranscriptQuery) => {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') qs.set(key, String(value))
    }
    return request<TranscriptPage>(`/api/transcripts?${qs}`)
  },

  transcript: (id: string) => request<TranscriptDetail>(`/api/transcripts/${id}`),

  importCsv: (file: File, batch?: string) => {
    const form = new FormData()
    form.append('file', file)
    if (batch) form.append('batch', batch)
    return request<ImportResult>('/api/import/csv', { method: 'POST', body: form })
  },

  stats: (days = 14) => request<StatsOverview>(`/api/stats/overview?days=${days}`),

  callbacks: (query: CallbackQuery) => {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') qs.set(key, String(value))
    }
    return request<CallbackPage>(`/api/stats/callbacks?${qs}`)
  },
}
