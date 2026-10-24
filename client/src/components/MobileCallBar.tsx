import type { CallPhase } from '../hooks/useTwilioDevice'
import type { Lead } from '../types'
import { formatDuration, PHASE_LABEL } from './CallPanel'

export function MobileCallBar({
  lead,
  phase,
  talkSeconds,
  muted,
  canDial,
  busy,
  blockedReason,
  liveWarning,
  onDial,
  onHangup,
  onToggleMute,
  onPickOutcome,
}: {
  lead: Lead | null
  phase: CallPhase
  talkSeconds: number
  muted: boolean
  canDial: boolean
  busy: boolean
  blockedReason: string | null
  liveWarning: string | null
  onDial: () => void
  onHangup: () => void
  onToggleMute: () => void
  onPickOutcome: () => void
}) {
  const inCall = phase === 'connecting' || phase === 'ringing' || phase === 'connected'
  const status =
    phase === 'idle' && blockedReason ? blockedReason : `${PHASE_LABEL[phase]} · ${formatDuration(talkSeconds)}`

  return (
    <div className="call-bar">
      {liveWarning && (phase === 'connected' || phase === 'ringing') && (
        <div className="call-bar-warning">{liveWarning}</div>
      )}
      <div className="call-bar-row">
        <div className="call-bar-info">
          <div className="call-bar-name">{lead?.businessName ?? 'No lead selected'}</div>
          <div className={`call-bar-status call-phase ${phase}`}>{status}</div>
        </div>
        {inCall ? (
          <>
            <button onClick={onToggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
            <button className="danger" onClick={onHangup}>
              Hang up
            </button>
          </>
        ) : phase === 'ended' ? (
          <button className="primary" onClick={onPickOutcome}>
            Pick outcome
          </button>
        ) : (
          <button className="primary" onClick={onDial} disabled={!canDial || busy}>
            Call
          </button>
        )}
      </div>
    </div>
  )
}
