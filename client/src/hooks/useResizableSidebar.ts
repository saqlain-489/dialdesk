import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'dd.sidebarWidth'
const MIN_WIDTH = 220
const MAX_WIDTH = 620
const DEFAULT_WIDTH = 300

function clamp(px: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)))
}

function readStored(): number {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? clamp(parsed) : DEFAULT_WIDTH
}

/**
 * Drag-to-resize for the queue column. The width is persisted because the caller
 * works one long shift a day — having to re-drag it every login is the kind of small
 * friction that gets an app abandoned.
 *
 * Listeners live on window rather than the handle so the drag survives the pointer
 * leaving the 6px strip, which it always does.
 */
export function useResizableSidebar(containerRef: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState<number>(() => {
    try {
      return readStored()
    } catch {
      return DEFAULT_WIDTH
    }
  })
  const [dragging, setDragging] = useState(false)
  const frame = useRef<number | null>(null)

  const startDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    setDragging(true)
  }, [])

  useEffect(() => {
    if (!dragging) return

    document.body.classList.add('resizing-columns')

    function onMove(event: MouseEvent) {
      // Coalesce to one update per frame; mousemove fires far faster than React can
      // usefully re-render, and the grid reflow is the expensive part.
      if (frame.current !== null) return
      frame.current = window.requestAnimationFrame(() => {
        frame.current = null
        const left = containerRef.current?.getBoundingClientRect().left ?? 0
        setWidth(clamp(event.clientX - left))
      })
    }

    function stop() {
      setDragging(false)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stop)
    // A drag that ends outside the window never fires mouseup on it.
    window.addEventListener('blur', stop)

    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', stop)
      window.removeEventListener('blur', stop)
      document.body.classList.remove('resizing-columns')
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current)
        frame.current = null
      }
    }
  }, [dragging, containerRef])

  // Written on settle rather than on every frame to avoid hammering localStorage.
  useEffect(() => {
    if (dragging) return
    try {
      window.localStorage.setItem(STORAGE_KEY, String(width))
    } catch {
      /* private mode — the width just won't persist */
    }
  }, [dragging, width])

  const reset = useCallback(() => setWidth(DEFAULT_WIDTH), [])

  return { width, dragging, startDrag, reset }
}
