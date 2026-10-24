import { env } from '../config/env.js'
import { checkCallWindow } from '../lib/callWindow.js'
import { loadOrg, voiceWebhookUrl } from '../lib/orgs.js'
import { formatForDisplay } from '../lib/phone.js'
import { safeRouter } from '../lib/safeRouter.js'

export const orgRouter = safeRouter()

// GET /api/org/setup — the open workspace's calling setup, for the Setup page and the dialer.
orgRouter.get('/setup', async (req, res) => {
  const org = await loadOrg(req.org!.id)
  const owner = req.org!.role === 'owner'
  res.json({
    workspace: req.org!.name,
    twilioConfigured: Boolean(org?.twilio),
    callerId: org?.twilio ? formatForDisplay(org.twilio.callerId) : null,
    callWindow: checkCallWindow(),
    // Twilio signs webhooks against this exact string; copy it into the TwiML App rather
    // than typing it. Owner only: callers never configure Twilio.
    voiceWebhookUrl: owner && org ? voiceWebhookUrl(env.publicUrl, org.slug) : null,
  })
})
