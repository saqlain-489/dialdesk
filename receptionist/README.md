# receptionist

A Cloudflare Worker that answers a dialdesk workspace's Twilio number when nobody picks up. It
rings the team's browsers for about 10 seconds, then hands the caller to **Ava**, an Azure Voice
Live agent that says it is an AI, takes a message, posts an alert and reports the call to the
dialdesk server, where it shows up under Metrics and Transcripts.

It runs on Workers rather than next to the app server because Twilio gives a voice webhook 15
seconds: an app on a free tier that sleeps can miss that window on a cold start. The worker is
always warm, and it queues its reports to the app until the app is awake.

## Call flow

```
number VoiceUrl      → POST /twilio/o/<ws>/inbound      <Dial timeout=10><Client>jordan.acme</Client></Dial>
  answered in browser → POST /twilio/o/<ws>/dial-result  <Hangup/>
  no-answer/busy/fail → POST /twilio/o/<ws>/dial-result  admission gate → <Connect><Stream …/twilio/stream> or spoken message
number StatusCallback → POST /twilio/o/<ws>/status       missed and human-answered calls → alert + ingest
number SmsUrl         → POST /twilio/o/<ws>/sms          forwarded as an alert, never replied to
number VoiceFallback  → POST /twilio/o/<ws>/ai           same gate, straight to the AI
WS   /twilio/stream   ⇄ Azure Voice Live (g711_ulaw both ways, no transcoding)
POST /internal/lead-context  (bearer)  the app says who it dialed, so Ava can ask "and that's with Cedar Dental?"
cron */5              redelivers reports that failed while the app server was asleep
```

## One worker, every workspace's number

Each dialdesk workspace has its own Twilio account and number. The `ORG_CONFIG` secret maps each
workspace slug to its account SID and Auth Token, the browser identities to ring, the `ownerName`
fallback and an optional alert webhook (see `wrangler.toml`). A number's webhooks go to
`/twilio/o/<slug>/<action>`, and each request must be signed with that workspace's Auth Token and
name its account. The workspace then rides inside the signed stream ticket, so the AI session uses
that workspace's lead context and Twilio account.

- Lead context is per workspace (`lead:<slug>:<phone>`) and carries `callerName`, the person who
  last dialed them. Ava introduces herself as that person's assistant, falling back to the
  workspace's `ownerName`. **The AI disclosure stays in the first turn for every workspace,** and
  tests assert it.
- Each report carries `org`; the app routes it by the number that rang and refuses a mismatch with
  a 4xx, which this worker treats as final (dropped, plus an alert) instead of retrying for a week.
- Without `ORG_CONFIG` the worker serves a single number from `TWILIO_*` and `INBOUND_CLIENTS`. With
  it, the bare `/twilio/<action>` URLs belong to `LEGACY_ORG`, so set both together.
- The Azure budget, the per-caller cap and the concurrency cap are shared by all numbers.

## Money and security guards

Every path that costs money is bounded; the header comments in `src/guard.js`, `src/phone.js`
and `src/twilio.js` explain each one.

- **Per call:** wrap-up at `PHONE_MAX_SECONDS` (300), silence wrap-up at `PHONE_SILENCE_SECONDS`
  (30), force-close 20s after either. Azure closes the moment the phone side does, and vice versa.
- **Per day:** `PHONE_MAX_DAILY_SECONDS` (3600) of AI time, `PHONE_MAX_AI_PER_NUMBER_PER_DAY` (3),
  `PHONE_MAX_CONCURRENT` (2). Checked at `/dial-result` **and** again at stream start.
- **Fail closed:** the kill switch `AI_ENABLED=false`, missing config or any KV error means the
  caller hears "Jordan will call you back" and an alert goes out. No AI session starts.
- **No socket abuse:** `/twilio/stream` opens Azure only after redeeming a 60-second, single-use
  HMAC ticket bound to the CallSid.
- **No forged webhooks:** every `/twilio/*` HTTP route checks `X-Twilio-Signature` (403 otherwise).
- **No toll fraud:** TwiML only ever dials the workspace's `<Client>` identities, never a
  `<Number>`, has no `<Redirect>`, and every document ends in `<Hangup/>`. Tests lock this in. The
  only Twilio REST call moves an existing call onto the spoken message; nothing creates calls or SMS.
- **Untrusted text stays inert:** business names are sanitised before they reach the prompt, and
  alerts never let caller-supplied text mention @everyone.
- **Secrets** live only in `wrangler secret`; logs carry CallSid and reason codes, never keys,
  headers or transcripts.

KV is eventually consistent, so the caps are soft; the per-call timer is the hard ceiling. The
app's ingest never downgrades an answered call to "missed" for the same reason.

## Setup

```bash
npm install
npx wrangler kv namespace create RECEPTIONIST_KV   # paste the id into wrangler.toml
# each name in .dev.vars.example, piped from a file rather than typed into a terminal:
npx wrangler secret put AZURE_VOICELIVE_ENDPOINT
npm run deploy
```

Then point each workspace's Twilio number at the worker (all POST):
`VoiceUrl=/twilio/o/<slug>/inbound`, `VoiceFallbackUrl=/twilio/o/<slug>/ai`,
`StatusCallback=/twilio/o/<slug>/status`, `SmsUrl=/twilio/o/<slug>/sms`. On the app server set
`RECEPTIONIST_URL=<worker url>` and `INBOUND_SHARED_SECRET=<same as the worker>`, then run
`npm run push:lead-context` once.

`scripts/check-voicelive.mjs` checks an Azure key with the worker's exact `session.update` and
never asks for audio. `scripts/simulate-call.mjs` plays a scripted caller against a deployed
worker; it uses about two minutes of paid Voice Live time.

## Commands

```bash
npm test        # 66 tests: signatures, TwiML safety, tickets, caps, workspaces, simulated calls end to end
npm run bundle  # wrangler dry run: bundles the worker without deploying
npm run dev     # wrangler dev on :8787
npm run tail    # live logs
```

## Known risk

The Workers free plan allows 10 ms of CPU per invocation. Phone audio is 50 frames a second each
way; if `tail` shows `exceededCpu`, batch media frames to 100 ms or move to the paid plan.
