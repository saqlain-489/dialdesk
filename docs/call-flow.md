# Call flows

## Outbound: a click in the browser to a ringing phone

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser (Voice SDK)
    participant S as dialdesk server
    participant T as Twilio
    participant L as Lead's phone

    B->>S: GET /api/twilio-token (session cookie)
    S-->>B: access token minted with the workspace's own API key
    B->>T: Device.connect with the LeadPhone param
    T->>S: POST /api/twilio/o/:ws/voice (signed with that workspace's Auth Token)
    Note over S: signature and AccountSid match the workspace<br/>US-dialable number<br/>lead owned by this workspace (allowlist)<br/>not on the do-not-call list<br/>inside calling hours in the lead's time zone<br/>caller is a member of the workspace
    S-->>T: TwiML Dial (answerOnBridge) with a Number status callback
    T->>L: rings
    T->>S: POST /api/twilio/o/:ws/number-status (in-progress)
    Note over S: stamps answeredAt: the talk timer starts here
    B->>S: GET /api/calls/:sid every 2 s
    S-->>B: answeredAt, dialStatus
    T->>S: POST /api/twilio/o/:ws/dial-status (DialCallStatus, DialCallDuration)
    Note over B: after hangup: pick an outcome,<br/>then Whisper transcribes both channels locally
    B->>S: PATCH /api/leads/:id/disposition, PUT /api/calls/:sid/transcript
```

Any check that fails answers with a spoken `<Say>` and `<Hangup/>`, so nothing is dialed. Three
details carry the design:

- **The lead allowlist is the toll-fraud control.** The webhook dials only a number the workspace
  owns as a lead, so a stolen session can't reach a premium-rate line or bill one workspace for
  another's lead.
- **`answerOnBridge` is the first verb.** The caller hears the carrier's real ringback, so
  disconnected numbers and intercept messages are audible at once. A `<Say>` before it would
  answer the call and void it.
- **The talk timer starts from the server.** With `answerOnBridge`, the SDK's `accept` event fires
  when ringback media arrives, not when the lead picks up. Only the `<Number>` status callback
  knows the real answer moment.

## Inbound: a callback when nobody picks up

```mermaid
sequenceDiagram
    autonumber
    participant C as Caller
    participant T as Twilio
    participant W as Receptionist worker
    participant B as Team browsers
    participant A as Azure Voice Live
    participant S as dialdesk server

    C->>T: calls the workspace's number
    T->>W: POST /twilio/o/:ws/inbound (signature checked)
    W-->>T: TwiML Dial to the team's Client identities, 10 s timeout
    T->>B: rings browsers that are taking inbound calls
    alt someone answers
        B-->>C: talks in the browser
    else no answer within 10 s
        T->>W: POST /twilio/o/:ws/dial-result
        Note over W: admission: kill switch, daily AI budget,<br/>per-number cap, concurrency cap (fail closed)
        W-->>T: TwiML Connect Stream with a 60 s single-use HMAC ticket
        T->>W: media stream (WebSocket), ticket redeemed and burned
        W->>A: session.update, then a short greeting that says it is an AI
        A-->>C: takes a message (name, callback time, number, email)
    end
    T->>W: POST /twilio/o/:ws/status (final)
    W->>S: POST /api/inbound/ingest (bearer), queued and retried by a cron if the app is asleep
    Note over S: routed by the number that rang<br/>call upserted by CallSid<br/>note added, lead moved to the top of the queue<br/>a do_not_call flag suppresses the number brand-wide
```

The worker never emits a `<Number>` or a `<Redirect>`, and every TwiML document ends in
`<Hangup/>`; tests assert all three. Its only REST call to Twilio moves an existing call onto the
spoken "we'll call you back" message.
