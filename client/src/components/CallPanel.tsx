import { useEffect, useRef, useState } from 'react'
import type { CallPhase } from '../hooks/useTwilioDevice'
import type { TranscriptionStage } from '../lib/transcription'
import { dialOutcome } from '../lib/callErrors'
import { canTranscribeHere } from '../lib/platform'
import type { Disposition, Lead } from '../types'
import { MicStatus } from './MicStatus'

// Ordered so the common outcomes sit under the first few keys.
const DISPOSITIONS: { value: Disposition; label: string; key: string; tone?: string }[] = [
  { value: 'no_answer', label: 'No answer', key: '1' },
  { value: 'voicemail', label: 'Voicemail', key: '2' },
  { value: 'busy', label: 'Busy', key: '3' },
  { value: 'connected', label: 'Talked, neutral', key: '4' },
  { value: 'not_interested', label: 'Not interested', key: '5', tone: 'red' },
  { value: 'interested', label: 'Interested', key: '6', tone: 'green' },
  { value: 'callback_later', label: 'Call back later', key: '7', tone: 'purple' },
  { value: 'booked', label: 'Booked!', key: '8', tone: 'green' },
  { value: 'wrong_number', label: 'Wrong number', key: '9', tone: 'red' },
  { value: 'do_not_call', label: 'Do not call', key: '0', tone: 'red' },
  { value: 'hung_up', label: 'Hung up on me', key: 'h', tone: 'red' },
  { value: 'other', label: 'Other…', key: 'o' },
]

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export const PHASE_LABEL: Record<CallPhase, string> = {
  idle: 'Ready',
  connecting: 'Connecting…',
  ringing: 'Ringing…',
  connected: 'Connected',
  ended: 'Call ended',
}

export function CallPanel({
  lead,
  phase,
  talkSeconds,
  muted,
  error,
  lastDialStatus,
  canDial,
  blockedReason,
  onDial,
  onHangup,
  onToggleMute,
  onDisposition,
  onSaveNote,
  onSkip,
  onArchive,
  busy,
  recording,
  transcribing,
  transcriptProblem,
  liveWarning,
  queuedTranscripts,
  recordingAllowed,
  micLabel,
}: {
  lead: Lead | null
  phase: CallPhase
  talkSeconds: number
  muted: boolean
  error: string | null
  lastDialStatus: string | null
  canDial: boolean
  blockedReason: string | null
  onDial: () => void
  onHangup: () => void
  onToggleMute: () => void
  onDisposition: (disposition: Disposition, note: string, callbackAt?: string, label?: string) => void
  onSaveNote: (leadId: string, note: string) => Promise<void>
  onSkip: () => void
  onArchive: () => void
  busy: boolean
  recording: boolean
  transcribing: TranscriptionStage | null
  transcriptProblem: string | null
  liveWarning: string | null
  queuedTranscripts: number
  recordingAllowed: boolean
  micLabel: string | null
}) {
  const [note, setNote] = useState('')
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [callbackAt, setCallbackAt] = useState('')
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherLabel, setOtherLabel] = useState('')
  const unsavedNote = useRef<{ leadId: string; text: string } | null>(null)
  const shownLeadId = useRef(lead?.id)

  // Leaving a lead (skip, archive, picking another) saves whatever note was typed for it.
  useEffect(() => {
    shownLeadId.current = lead?.id
    const left = unsavedNote.current
    unsavedNote.current = null
    if (left && left.leadId !== lead?.id) void onSaveNote(left.leadId, left.text).catch(() => undefined)
    setNote('')
    setNoteState('idle')
    setCallbackAt('')
  }, [lead?.id])

  const inCall = phase === 'connecting' || phase === 'ringing' || phase === 'connected'
  // Disposition is required before moving on — without it the call data is worthless.
  const needsDisposition = phase === 'ended'

  useEffect(() => {
    if (!needsDisposition) {
      setOtherOpen(false)
      setOtherLabel('')
    }
  }, [needsDisposition])

  function editNote(text: string) {
    setNote(text)
    setNoteState('idle')
    unsavedNote.current = lead && text.trim() ? { leadId: lead.id, text: text.trim() } : null
  }

  async function saveNote() {
    const body = note.trim()
    if (!lead || !body || noteState === 'saving') return
    const leadId = lead.id
    unsavedNote.current = null
    setNoteState('saving')
    try {
      await onSaveNote(leadId, body)
      if (shownLeadId.current !== leadId) return
      setNote((current) => (current.trim() === body ? '' : current))
      setNoteState('saved')
    } catch {
      if (shownLeadId.current !== leadId) return
      unsavedNote.current ??= { leadId, text: body }
      setNoteState('error')
    }
  }

  function pick(disposition: Disposition) {
    if (disposition === 'other') {
      setOtherOpen(true)
      return
    }
    unsavedNote.current = null
    onDisposition(disposition, note, callbackAt || undefined)
  }

  function saveOther() {
    const label = otherLabel.trim()
    if (!label) return
    unsavedNote.current = null
    onDisposition('other', note, callbackAt || undefined, label)
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      if (e.code === 'Space') {
        e.preventDefault()
        if (inCall) onHangup()
        else if (canDial && !needsDisposition) onDial()
        return
      }
      if (e.key === 'm' && inCall) {
        onToggleMute()
        return
      }
      if (needsDisposition && !busy && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const match = DISPOSITIONS.find((d) => d.key === e.key.toLowerCase())
        if (match) {
          e.preventDefault()
          pick(match.value)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!lead) {
    return (
      <div className="pane call-pane">
        <h2>Call</h2>
        <div className="notice">Select a lead from the queue.</div>
      </div>
    )
  }

  return (
    <div className="pane call-pane">
      <h2>Call</h2>

      {error && <div className="error-box">{error}</div>}
      {liveWarning && (phase === 'connected' || phase === 'ringing') && (
        <div className="error-box">{liveWarning}</div>
      )}
      {blockedReason && !error && <div className="error-box">{blockedReason}</div>}

      <div className="call-status">
        <div className={`call-phase ${phase}`}>{PHASE_LABEL[phase]}</div>
        <div className="call-timer">{formatDuration(talkSeconds)}</div>
        {lastDialStatus && phase === 'ended' && (
          <div className="notice" style={{ fontSize: 13 }}>
            <strong>{dialOutcome(lastDialStatus).title}</strong> — {dialOutcome(lastDialStatus).action}
          </div>
        )}        {phase === 'ringing' && (
          <div className="muted" style={{ fontSize: 12 }}>
            Timer starts when they pick up
          </div>
        )}
        {recording && <div className="badge red">● Recording for transcript</div>}
        {phase === 'idle' && !canTranscribeHere && (
          <div className="muted" style={{ fontSize: 12 }}>
            No transcript on a phone (transcripts run on a laptop)
          </div>
        )}
        {phase === 'idle' && canTranscribeHere && !recordingAllowed && (
          <div className="muted" style={{ fontSize: 12 }}>
            Transcript off for this lead's state
          </div>
        )}
        {transcriptProblem && !transcribing && (
          <div className="badge yellow" style={{ whiteSpace: 'normal' }}>
            {transcriptProblem}
          </div>
        )}
        {transcribing && (
          <div className="muted" style={{ fontSize: 12 }}>
            {transcribing.callSid === 'preload' ? 'Preparing transcriber' : 'Transcribing previous call'}:{' '}
            {transcribing.stage}
            {transcribing.pct !== null ? ` ${transcribing.pct}%` : ''}
          </div>
        )}
        {queuedTranscripts > 0 && (phase === 'connected' || phase === 'ringing' || phase === 'connecting') && (
          <div className="muted" style={{ fontSize: 12 }}>
            {queuedTranscripts} transcript{queuedTranscripts > 1 ? 's' : ''} paused — will finish after this call
          </div>
        )}
        <MicStatus label={micLabel} />
      </div>

      <div className="btn-row call-actions" style={{ marginBottom: 12 }}>
        {!inCall ? (
          <button
            className="primary"
            onClick={onDial}
            disabled={!canDial || busy || needsDisposition}
            title={blockedReason ?? 'Space'}
          >
            Call {lead.phoneDisplay}
          </button>
        ) : (
          <>
            <button className="danger" onClick={onHangup}>
              Hang up
            </button>
            <button onClick={onToggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
          </>
        )}
      </div>

      {needsDisposition && (
        <>
          <div className="card-section">
            <h4>How did it go? (required)</h4>
            <div className="disposition-grid">
              {DISPOSITIONS.map((d) => (
                <button
                  key={d.value}
                  className={[d.tone ? `badge-${d.tone}` : '', d.value === 'other' && otherOpen ? 'primary' : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => pick(d.value)}
                  disabled={busy}
                >
                  <span className="key">{d.key.toUpperCase()}</span> {d.label}
                </button>
              ))}
            </div>
            {otherOpen && (
              <div className="other-outcome">
                <input
                  autoFocus
                  maxLength={80}
                  placeholder="What happened? e.g. gatekeeper, no English"
                  value={otherLabel}
                  onChange={(e) => setOtherLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveOther()
                    if (e.key === 'Escape') setOtherOpen(false)
                  }}
                />
                <button className="primary" onClick={saveOther} disabled={busy || !otherLabel.trim()}>
                  Save outcome
                </button>
              </div>
            )}
          </div>

          <div className="card-section">
            <h4>Call back at (optional)</h4>
            <input
              type="datetime-local"
              value={callbackAt}
              onChange={(e) => setCallbackAt(e.target.value)}
            />
          </div>
        </>
      )}

      <div className="card-section">
        <h4>Note</h4>
        <textarea
          rows={4}
          placeholder="What did they say?"
          value={note}
          onChange={(e) => editNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void saveNote()
          }}
        />
        <div className="note-actions">
          <span className={`muted${noteState === 'error' ? ' note-error' : ''}`}>
            {noteState === 'saved'
              ? 'Note saved to this lead'
              : noteState === 'error'
                ? 'Not saved, try again'
                : needsDisposition
                  ? 'Also saved with the outcome'
                  : 'Ctrl+Enter saves'}
          </span>
          <button onClick={() => void saveNote()} disabled={!note.trim() || noteState === 'saving'}>
            {noteState === 'saving' ? 'Saving…' : 'Save note'}
          </button>
        </div>
      </div>

      {!needsDisposition && (
        <div className="btn-row">
          <button onClick={onSkip} disabled={inCall} style={{ flex: 1 }}>
            Skip to next lead
          </button>
          <button
            onClick={onArchive}
            disabled={inCall || busy}
            title="Remove from the queue without recording an outcome. Reversible."
          >
            Archive
          </button>
        </div>
      )}

      <div className="muted kbd-hint" style={{ fontSize: 12, marginTop: 12 }}>
        <strong>Space</strong> call / hang up · <strong>M</strong> mute · <strong>0–9 H O</strong> outcome
      </div>
    </div>
  )
}
