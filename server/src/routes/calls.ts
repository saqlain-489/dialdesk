import type { Request } from 'express'
import { Call, TRANSCRIPT_SPEAKERS } from '../models/Call.js'
import { Lead } from '../models/Lead.js'
import { env } from '../config/env.js'
import { safeRouter } from '../lib/safeRouter.js'

export const callsRouter = safeRouter()

// A CallSid alone would let any session read or write any call; it must also be this workspace's.
const callKey = (req: Request) => ({ orgId: req.org!.id, parentCallSid: req.params.sid })

type IncomingLine = { speaker?: string; start?: number; end?: number; text?: string }

const MAX_LINES = 2000
const MAX_TEXT = 200_000

// GET /api/calls/:sid
// The browser polls this during a live call. With answerOnBridge the SDK's own
// 'accept' event fires when ringback media arrives, not when the lead picks up —
// so the true answer moment only exists server-side, via the <Number> status callback.
callsRouter.get('/:sid', async (req, res) => {
  const call = await Call.findOne(callKey(req))
  if (!call) {
    res.status(404).json({ error: 'call not found' })
    return
  }
  res.json({
    callSid: call.parentCallSid,
    dialStatus: call.dialStatus ?? null,
    answeredAt: call.answeredAt ?? null,
    endedAt: call.endedAt ?? null,
    duration: call.duration ?? 0,
    hasTranscript: Boolean(call.transcript?.text),
  })
})

// PUT /api/calls/:sid/transcript — written by the caller's browser after hangup.
// The audio itself never leaves that machine; only this text is uploaded.
callsRouter.put('/:sid/transcript', async (req, res) => {
  const { text, lines, model, processingSeconds } = req.body as {
    text?: string
    lines?: IncomingLine[]
    model?: string
    processingSeconds?: number
  }

  if (!text?.trim()) {
    res.status(400).json({ error: 'text is required' })
    return
  }
  if (text.length > MAX_TEXT) {
    res.status(413).json({ error: 'transcript too large' })
    return
  }

  const call = await Call.findOne(callKey(req))
  if (!call) {
    res.status(404).json({ error: 'call not found' })
    return
  }

  // Re-check the consent gate server-side. The client already hides recording for
  // disallowed states, but a stale tab holding an old lead payload must not be able
  // to land a transcript for an all-party state.
  const lead = await Lead.findOne({ _id: call.leadId, orgId: req.org!.id }, { state: 1 })
  const state = lead?.state?.trim().toUpperCase()
  if (!env.transcription.enabled || !state || !env.transcription.states.includes(state)) {
    res.status(403).json({ error: 'transcription not permitted for this lead' })
    return
  }

  const clean = (lines ?? [])
    .slice(0, MAX_LINES)
    .filter((l) => l.text?.trim() && TRANSCRIPT_SPEAKERS.includes(l.speaker as never))
    .map((l) => ({
      speaker: l.speaker as (typeof TRANSCRIPT_SPEAKERS)[number],
      start: Number(l.start) || 0,
      end: Number.isFinite(Number(l.end)) ? Number(l.end) : undefined,
      text: String(l.text).trim(),
    }))

  call.set({
    transcript: {
      text: text.trim(),
      lines: clean,
      model: model ?? env.transcription.model,
      processingSeconds: Number.isFinite(Number(processingSeconds))
        ? Number(processingSeconds)
        : undefined,
      createdAt: new Date(),
    },
    transcriptError: undefined,
  })
  await call.save()

  res.json({ ok: true, lines: clean.length })
})

// PUT /api/calls/:sid/transcript-error — why a transcript never arrived. Carries no call content.
callsRouter.put('/:sid/transcript-error', async (req, res) => {
  const { stage, message } = req.body as { stage?: string; message?: string }
  if (!stage?.trim()) {
    res.status(400).json({ error: 'stage is required' })
    return
  }

  const call = await Call.findOne(callKey(req))
  if (!call) {
    res.status(404).json({ error: 'call not found' })
    return
  }
  if (call.transcript?.text) {
    res.json({ ok: true, ignored: true })
    return
  }

  call.set({
    transcriptError: { stage: stage.trim().slice(0, 40), message: message?.slice(0, 500), at: new Date() },
  })
  await call.save()
  res.json({ ok: true })
})

// PUT /api/calls/:sid/quality — per-call audio/network summary so "they couldn't hear me" can be traced.
callsRouter.put('/:sid/quality', async (req, res) => {
  const body = req.body as Record<string, unknown>
  // Number(null) is 0, which would record "no data" as a perfect 0.
  const num = (key: string) =>
    body[key] != null && Number.isFinite(Number(body[key])) ? Number(body[key]) : undefined
  const str = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : undefined)
  const bool = (value: unknown) => (typeof value === 'boolean' ? value : undefined)
  const warnings = Array.isArray(body.warnings)
    ? body.warnings.filter((w): w is string => typeof w === 'string').slice(0, 20).map((w) => w.slice(0, 40))
    : []
  const mic = body.mic && typeof body.mic === 'object' ? (body.mic as Record<string, unknown>) : null
  const warningEvents = Array.isArray(body.warningEvents)
    ? (body.warningEvents as Record<string, unknown>[])
        .filter((e) => e && typeof e.name === 'string' && Number.isFinite(Number(e.at)))
        .slice(0, 60)
        .map((e) => ({ name: String(e.name).slice(0, 40), at: Number(e.at), cleared: e.cleared === true }))
    : undefined

  const call = await Call.findOne(callKey(req))
  if (!call) {
    res.status(404).json({ error: 'call not found' })
    return
  }
  call.set({
    quality: {
      samples: num('samples'),
      avgMicLevel: num('avgMicLevel'),
      silentMicPct: num('silentMicPct'),
      maxPacketLossPct: num('maxPacketLossPct'),
      avgPacketLossPct: num('avgPacketLossPct'),
      avgMos: num('avgMos'),
      maxRttMs: num('maxRttMs'),
      avgJitterMs: num('avgJitterMs'),
      warnings,
      outLossPct: num('outLossPct'),
      maxOutLossPct: num('maxOutLossPct'),
      avgOutJitterMs: num('avgOutJitterMs'),
      voiceDb: num('voiceDb'),
      voiceFloorDb: num('voiceFloorDb'),
      voicePeakDb: num('voicePeakDb'),
      codec: str(body.codec, 20),
      edge: str(body.edge, 30),
      mic: mic
        ? {
            label: str(mic.label, 80),
            autoGainControl: bool(mic.autoGainControl),
            echoCancellation: bool(mic.echoCancellation),
            noiseSuppression: bool(mic.noiseSuppression),
          }
        : undefined,
      warningEvents,
    },
  })
  await call.save()
  res.json({ ok: true })
})
