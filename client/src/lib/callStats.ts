let latest: RTCPeerConnection | null = null

// The Voice SDK keeps its peer connection private; Device's documented RTCPeerConnection option lets us hold it.
export function trackingPeerConnection(): typeof RTCPeerConnection {
  return class TrackedPeerConnection extends RTCPeerConnection {
    constructor(configuration?: RTCConfiguration) {
      super(configuration)
      latest = this
    }
  }
}

export function livePeerConnection(): RTCPeerConnection | null {
  return latest && latest.connectionState !== 'closed' ? latest : null
}

export type OutboundStats = {
  fractionLostPct: number
  packetsLost: number
  packetsSent: number
  jitterMs: number
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export type VoiceStats = {
  energy: number
  seconds: number
  level: number
}

// media-source is the mic audio handed to the encoder after Chrome's noise suppression: what Twilio forwards to the lead.
export function readVoice(report: RTCStatsReport): VoiceStats | null {
  let source: Record<string, unknown> | null = null
  report.forEach((stat: Record<string, unknown>) => {
    if (stat.type === 'media-source' && stat.kind === 'audio') source = stat
  })
  if (!source) return null
  const s: Record<string, unknown> = source
  if (typeof s.totalAudioEnergy !== 'number' || typeof s.totalSamplesDuration !== 'number') return null
  return { energy: s.totalAudioEnergy, seconds: s.totalSamplesDuration, level: num(s.audioLevel) }
}

// remote-inbound-rtp is Twilio's report on our stream; the SDK's own loss/jitter only cover the lead's audio.
export function readOutbound(report: RTCStatsReport): OutboundStats | null {
  let remote: Record<string, unknown> | null = null
  let outbound: Record<string, unknown> | null = null
  report.forEach((stat: Record<string, unknown>) => {
    if (stat.kind !== 'audio') return
    if (stat.type === 'remote-inbound-rtp') remote = stat
    if (stat.type === 'outbound-rtp') outbound = stat
  })
  if (!remote) return null
  const r: Record<string, unknown> = remote
  const o: Record<string, unknown> = outbound ?? {}
  return {
    fractionLostPct: num(r.fractionLost) * 100,
    packetsLost: num(r.packetsLost),
    packetsSent: num(o.packetsSent),
    jitterMs: num(r.jitter) * 1000,
  }
}
