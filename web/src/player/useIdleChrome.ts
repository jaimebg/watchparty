import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

const IDLE_MS = 3000

// Retires the controls, the floating chat and the reactions bar after a spell of
// inactivity, and brings them back at the first sign of life. It only arms in
// fullscreen: outside it the chrome is always visible.
export function useIdleChrome({
  enabled, container, isBlocked, idleMs = IDLE_MS,
}: {
  enabled: boolean
  container: RefObject<HTMLElement | null>
  // Returns true while the chrome may NOT leave yet (something is being typed,
  // or the room is paused). A function rather than a boolean so the timer
  // consults the value at the moment it expires, not the one from when it was
  // armed.
  isBlocked: () => boolean
  idleMs?: number
}): { awake: boolean; wake: () => void } {
  const [awake, setAwake] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const isBlockedRef = useRef(isBlocked)
  isBlockedRef.current = isBlocked

  const wake = useCallback(() => {
    setAwake(true)
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    if (!enabledRef.current) return
    const sleep = () => {
      if (isBlockedRef.current()) { timerRef.current = setTimeout(sleep, idleMs); return }
      timerRef.current = null
      setAwake(false)
    }
    timerRef.current = setTimeout(sleep, idleMs)
  }, [idleMs])

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null }
      setAwake(true)
      return
    }
    const el = container.current
    wake()
    // The keyboard listener goes on `window` and not on the container: in
    // fullscreen the focus can sit on the <body>, which is not a descendant of
    // the container as far as key bubbling is concerned.
    window.addEventListener('keydown', wake)
    el?.addEventListener('pointermove', wake)
    el?.addEventListener('pointerdown', wake)
    el?.addEventListener('focusin', wake)
    return () => {
      if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null }
      window.removeEventListener('keydown', wake)
      el?.removeEventListener('pointermove', wake)
      el?.removeEventListener('pointerdown', wake)
      el?.removeEventListener('focusin', wake)
    }
  }, [enabled, container, wake])

  return { awake, wake }
}
