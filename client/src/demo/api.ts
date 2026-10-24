import type { ApiClient } from '../api'
import * as store from './store'

// A short delay keeps loading states honest without making the demo feel slow.
function later<T>(work: () => T | Promise<T>, ms = 80): Promise<T> {
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      Promise.resolve().then(work).then(resolve, reject)
    }, ms)
  })
}

export function createDemoApi(): ApiClient {
  return {
    health: () => later(() => ({ ok: true, publicUrl: 'https://dialdesk.example.com', callWindow: store.callWindow() }), 20),
    me: () => later(store.session, 20),
    login: () => later(store.signIn, 250),
    switchOrg: (orgId) => later(() => store.switchOrg(orgId)),
    orgSetup: () => later(store.orgSetup),
    logout: () =>
      later(() => {
        store.signOut()
        return { ok: true as const }
      }),
    queue: (params = {}) => later(() => store.queue(params)),
    facets: () => later(store.facets),
    archiveLead: (leadId, reason) => later(() => store.archive(leadId, reason)),
    restoreLead: (leadId) => later(() => store.restore(leadId)),
    deleteLead: (leadId) => later(() => store.remove(leadId)),
    bulkArchive: (filter, expectedCount, reason) => later(() => store.bulkArchive(filter, expectedCount, reason)),
    recycleLead: () => later(store.recycle),
    bulkRecycle: () => later(store.recycle),
    batches: () => later(store.batches),
    leadDetail: (leadId) => later(() => store.leadDetail(leadId)),
    disposition: (leadId, body) => later(() => store.disposition(leadId, body)),
    updateLead: (leadId, body) => later(() => store.updateLead(leadId, body)),
    twilioToken: () => later(store.noTwilio),
    callStatus: (sid) => later(() => store.callStatus(sid)),
    saveCallQuality: () => later(() => ({ ok: true as const })),
    reportTranscriptError: () => later(() => ({ ok: true as const })),
    saveTranscript: (_sid, body) => later(() => ({ ok: true as const, lines: body.lines.length })),
    transcripts: (query) => later(() => store.transcripts(query)),
    transcript: (id) => later(() => store.transcript(id)),
    importCsv: (file, batch) => later(() => store.importCsv(file, batch), 400),
    stats: (days = 14) => later(() => store.stats(days)),
    callbacks: (query) => later(() => store.callbacks(query)),
  }
}
