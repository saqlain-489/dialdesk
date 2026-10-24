import { useEffect } from 'react'

// A phone that auto-locks mid-call backgrounds the page, and iOS then cuts the mic.
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let cancelled = false

    const acquire = () => {
      navigator.wakeLock
        .request('screen')
        .then((sentinel) => {
          if (cancelled) void sentinel.release()
          else lock = sentinel
        })
        .catch(() => undefined)
    }
    // The browser drops the lock whenever the page is hidden, so take it again on return.
    const onVisible = () => {
      if (document.visibilityState === 'visible') acquire()
    }

    acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release().catch(() => undefined)
    }
  }, [active])
}
