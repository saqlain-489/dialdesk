import type { NextFunction, Request, Response } from 'express'
import twilio from 'twilio'
import { env } from '../config/env.js'
import { Call } from '../models/Call.js'
import { Lead } from '../models/Lead.js'
import { User } from '../models/User.js'
import { checkCallWindow } from '../lib/callWindow.js'
import { loadOrgBySlug, type LoadedOrg, type OrgTwilio } from '../lib/orgs.js'
import { isDialableUsNumber } from '../lib/phone.js'
import { pushLeadContext } from '../lib/receptionist.js'
import { safeRouter } from '../lib/safeRouter.js'
import { isSuppressed } from '../lib/suppression.js'

export const twilioWebhookRouter = safeRouter()

const VoiceResponse = twilio.twiml.VoiceResponse

type WebhookOrg = LoadedOrg & { twilio: OrgTwilio }

const orgOf = (res: Response) => res.locals.org as WebhookOrg

// Each workspace's TwiML App posts to /api/twilio/o/<slug>/…; the bare paths are TwiML
// Apps set up before workspaces, which belong to LEGACY_WEBHOOK_ORG.
const routes = (action: string) => [`/o/:slug/${action}`, `/${action}`]

// Twilio signs each webhook against its exact URL. Reconstructing that URL from request
// headers breaks behind a platform proxy (req.protocol is http, and the Host header may be
// rewritten), which shows up as a 403 on a request that looks perfectly healthy. Pinning
// PUBLIC_URL removes all of that guesswork.
//
// The signature is HMAC-SHA1 over the workspace's account AUTH TOKEN — not the API key
// secret used to mint access tokens. An unknown workspace, another account's signature or
// a body naming a different AccountSid all get the same 403.
async function verifyTwilio(req: Request, res: Response, next: NextFunction): Promise<void> {
  const slug = req.params.slug ?? env.twilio.legacyWebhookOrg
  const org = slug ? await loadOrgBySlug(slug) : null
  const signature = req.get('x-twilio-signature') ?? ''
  const valid =
    org?.twilio &&
    req.body.AccountSid === org.twilio.accountSid &&
    twilio.validateRequest(org.twilio.authToken, signature, `${env.publicUrl}${req.originalUrl}`, req.body)
  if (!valid) {
    res.status(403).type('text/plain').send('forbidden')
    return
  }
  res.locals.org = org
  next()
}

function say(res: Response, message: string): void {
  const twiml = new VoiceResponse()
  twiml.say({ voice: 'alice' }, message)
  twiml.hangup()
  res.type('text/xml').send(twiml.toString())
}

// The identity baked into the access token arrives as `From: client:<identity>`.
// It comes from Twilio, not the browser, so it's safe to attribute calls with.
function identityFrom(from: string | undefined): string | null {
  if (!from?.startsWith('client:')) return null
  return from.slice('client:'.length) || null
}

// POST /api/twilio/o/:slug/voice — TwiML App voice URL. Fires when the browser places a call.
twilioWebhookRouter.post(routes('voice'), verifyTwilio, async (req, res) => {
  const org = orgOf(res)
  const leadPhone = String(req.body.LeadPhone ?? '').trim()
  const parentCallSid = String(req.body.CallSid ?? '')
  const identity = identityFrom(req.body.From)

  if (!isDialableUsNumber(leadPhone)) {
    say(res, 'That number is not a dialable US number. The call was blocked.')
    return
  }

  // Allowlist: only a lead this workspace currently owns can ever be dialed. This is what
  // makes a stolen session token worthless — an attacker cannot point this app at a
  // premium-rate number, nor one workspace's account at another workspace's leads.
  const lead = await Lead.findOne({ orgId: org.id, phone: leadPhone, claimed: true })
  if (!lead) {
    say(res, 'That number is not in the lead list. The call was blocked.')
    return
  }
  if (lead.doNotCall || (await isSuppressed(leadPhone))) {
    say(res, 'This lead is marked do not call. The call was blocked.')
    return
  }

  const window = checkCallWindow()
  if (!window.open) {
    say(res, 'Calling is currently outside the permitted hours. The call was blocked.')
    return
  }

  const user = identity ? await User.findOne({ username: identity, 'memberships.orgId': org.id }) : null
  if (!user) {
    say(res, 'This caller is not a member of this workspace. The call was blocked.')
    return
  }

  // Increment first so the Call row can record which attempt it was. The filter re-checks
  // ownership and do-not-call, so a lead suppressed or moved a moment ago is never dialed.
  const counted = await Lead.findOneAndUpdate(
    { _id: lead._id, orgId: org.id, claimed: true, doNotCall: { $ne: true } },
    { $inc: { attempts: 1 }, $set: { lastCalledAt: new Date() } },
    { new: true, projection: { attempts: 1 } },
  )
  if (!counted) {
    say(res, 'This lead can no longer be called. The call was blocked.')
    return
  }

  await Call.create({
    orgId: org.id,
    leadId: lead._id,
    userId: user._id,
    username: user.username,
    to: leadPhone,
    from: org.twilio.callerId,
    attemptNumber: counted.attempts,
    parentCallSid,
    startedAt: new Date(),
    dialStatus: 'initiated',
  })

  // Not awaited: the TwiML below must go back to Twilio without waiting on the worker.
  void pushLeadContext(org.slug, [
    {
      phone: lead.phone,
      businessName: lead.businessName,
      website: lead.website ?? null,
      callerName: user.displayName,
    },
  ])

  const base = `${env.publicUrl}/api/twilio/o/${org.slug}`
  const twiml = new VoiceResponse()
  // answerOnBridge must be on the first verb — any <Say>/<Play> before this would
  // answer the call and silently void it. It gives the caller the carrier's real
  // ringback, so disconnected numbers and intercepts are audible immediately.
  const dial = twiml.dial({
    callerId: org.twilio.callerId,
    answerOnBridge: true,
    timeout: 25,
    action: `${base}/dial-status`,
    method: 'POST',
  })
  dial.number(
    {
      statusCallback: `${base}/number-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    },
    leadPhone,
  )

  res.type('text/xml').send(twiml.toString())
})

// POST /api/twilio/o/:slug/dial-status — <Dial action>. The authoritative call outcome.
// The TwiML-App-level status callback describes only the browser leg; this one
// describes the lead's leg, which is the number that actually matters.
twilioWebhookRouter.post(routes('dial-status'), verifyTwilio, async (req, res) => {
  const parentCallSid = String(req.body.CallSid ?? '')
  const dialStatus = String(req.body.DialCallStatus ?? '')
  const dialCallSid = String(req.body.DialCallSid ?? '')
  const duration = Number(req.body.DialCallDuration ?? 0)

  if (parentCallSid) {
    await Call.findOneAndUpdate(
      { orgId: orgOf(res).id, parentCallSid },
      {
        $set: {
          dialStatus: dialStatus || 'completed',
          dialCallSid: dialCallSid || undefined,
          duration: Number.isNaN(duration) ? 0 : duration,
          endedAt: new Date(),
        },
      },
    )
  }

  // Empty response hangs up the parent leg rather than continuing to more TwiML.
  res.type('text/xml').send(new VoiceResponse().toString())
})

// POST /api/twilio/o/:slug/number-status — per-leg progress on the <Number> noun.
// Used only to stamp answeredAt, which is when the talk timer should really start.
twilioWebhookRouter.post(routes('number-status'), verifyTwilio, async (req, res) => {
  const status = String(req.body.CallStatus ?? '')
  const parentCallSid = String(req.body.ParentCallSid ?? '')

  if (status === 'in-progress' && parentCallSid) {
    await Call.findOneAndUpdate(
      { orgId: orgOf(res).id, parentCallSid, answeredAt: { $exists: false } },
      { $set: { answeredAt: new Date(), dialStatus: 'answered' } },
    )
  }

  res.sendStatus(204)
})
