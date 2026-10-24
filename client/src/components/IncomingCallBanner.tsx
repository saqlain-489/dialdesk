import type { InboundCall } from '../hooks/useTwilioDevice'
import type { Lead } from '../types'

function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || 'Unknown number'
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

type Props = {
  enabled: boolean
  busy: boolean
  inbound: InboundCall | null
  seconds: number
  muted: boolean
  leads: Lead[]
  onEnable: () => void
  onDisable: () => void
  onAccept: () => void
  onReject: () => void
  onHangup: () => void
  onToggleMute: () => void
}

export function IncomingCallBanner(props: Props) {
  const { enabled, busy, inbound, seconds, muted, leads } = props

  if (inbound) {
    const lead = leads.find((l) => l.phone === inbound.from)
    const who = lead ? `${lead.businessName} · ${formatPhone(inbound.from)}` : formatPhone(inbound.from)
    return (
      <div className="banner open" role="alert">
        {inbound.status === 'ringing' ? (
          <>
            <strong>Incoming call</strong>
            <span>{who}</span>
            <span style={{ flex: 1 }} />
            <button className="primary" onClick={props.onAccept}>
              Answer
            </button>
            <button onClick={props.onReject} title="The AI receptionist answers instead">
              Send to AI
            </button>
          </>
        ) : (
          <>
            <strong>On a call · {clock(seconds)}</strong>
            <span>{who}</span>
            <span style={{ flex: 1 }} />
            <button onClick={props.onToggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
            <button className="danger" onClick={props.onHangup}>
              Hang up
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="banner muted inbound-idle">
      <span className="inbound-long" style={{ flex: 1 }}>
        {enabled
          ? 'Taking inbound calls: callbacks ring here for about 10 seconds, then the AI receptionist answers.'
          : 'Inbound calls go straight to the AI receptionist.'}
      </span>
      <span className="inbound-short" style={{ flex: 1 }}>
        {enabled ? 'Taking inbound calls' : 'Inbound calls → AI receptionist'}
      </span>
      <button disabled={busy} onClick={enabled ? props.onDisable : props.onEnable}>
        {busy ? '…' : enabled ? 'Stop taking calls' : 'Take inbound calls'}
      </button>
    </div>
  )
}
