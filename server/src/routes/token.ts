import twilio from 'twilio'
import { env } from '../config/env.js'
import { loadOrg } from '../lib/orgs.js'
import { safeRouter } from '../lib/safeRouter.js'

export const tokenRouter = safeRouter()

const AccessToken = twilio.jwt.AccessToken
const VoiceGrant = AccessToken.VoiceGrant

// GET /api/twilio-token
// Behind requireAuth. Identity is taken from the session, never from the request body —
// the TwiML webhook trusts this identity (as `From: client:<identity>`) to attribute calls.
// Minted with the open workspace's own Twilio account, so calls bill to that workspace.
tokenRouter.get('/', async (req, res) => {
  const org = await loadOrg(req.org!.id)
  if (!org?.twilio) {
    res.status(503).json({ error: 'calling is not set up for this workspace yet' })
    return
  }

  // Twilio scopes client identities per account, and each workspace has its own account,
  // so the plain username can't collide with another workspace's browser.
  const identity = req.user!.username

  const grant = new VoiceGrant({
    outgoingApplicationSid: org.twilio.twimlAppSid,
    // The receptionist worker rings this identity with <Dial><Client> before handing
    // the caller to the AI. The browser only receives calls while it has registered.
    incomingAllow: true,
  })

  const token = new AccessToken(org.twilio.accountSid, org.twilio.apiKeySid, org.twilio.apiKeySecret, {
    identity,
    ttl: env.twilio.tokenTtlSeconds,
  })
  token.addGrant(grant)

  res.json({
    token: token.toJwt(),
    identity,
    expiresInSeconds: env.twilio.tokenTtlSeconds,
  })
})
