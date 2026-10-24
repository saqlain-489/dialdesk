import { useEffect, useState } from 'react'

// The mic Chrome hands the call when no device is chosen. Labels stay empty until the site may use the mic.
async function defaultMicLabel(): Promise<string | null> {
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  const chosen = inputs.find((d) => d.deviceId === 'default') ?? inputs[0]
  return chosen?.label || null
}

// The live call's own track wins; between calls, re-read on plug/unplug and after each call (the first one grants the labels).
export function useMicName(callMicLabel: string | null, refreshKey: unknown): string | null {
  const [label, setLabel] = useState<string | null>(null)

  useEffect(() => {
    const media = navigator.mediaDevices
    if (!media?.enumerateDevices) return
    let cancelled = false
    const read = () =>
      void defaultMicLabel()
        .then((next) => {
          if (!cancelled) setLabel(next)
        })
        .catch(() => undefined)
    read()
    media.addEventListener('devicechange', read)
    return () => {
      cancelled = true
      media.removeEventListener('devicechange', read)
    }
  }, [refreshKey])

  return callMicLabel || label
}
