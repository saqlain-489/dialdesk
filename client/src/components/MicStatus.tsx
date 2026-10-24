import { isBuiltInMic, micName } from '../lib/micInfo'

export function MicStatus({ label }: { label: string | null }) {
  if (!label) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        Mic: not known yet. It shows once Chrome is allowed to use the microphone.
      </div>
    )
  }

  const name = micName(label)
  return (
    <>
      <div className="muted" style={{ fontSize: 12 }}>
        Mic: <strong>{name === 'Default' ? 'System default (pick it in Sound settings → Input)' : name}</strong>
      </div>
      {isBuiltInMic(name) && (
        <div className="badge yellow" style={{ whiteSpace: 'normal' }}>
          This is the laptop's own mic, not your headset. Leads hear it as "I can't hear you". Plug in the headset,
          choose its mic in Sound settings → Input, then run Setup → Mic check.
        </div>
      )}
    </>
  )
}
