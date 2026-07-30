import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

const IDLE_MS = 3000

// Retira controles, chat flotante y barra de reacciones tras un rato sin
// actividad, y los devuelve a la primera señal de vida. Solo se arma en
// pantalla completa: fuera de ella el chrome se ve siempre.
export function useIdleChrome({
  enabled, container, isBlocked, idleMs = IDLE_MS,
}: {
  enabled: boolean
  container: RefObject<HTMLElement | null>
  // Devuelve true cuando el chrome NO puede irse todavía (se está escribiendo,
  // o la sala está en pausa). Es una función y no un booleano para que el
  // temporizador consulte el valor del momento en que vence, no el de cuando
  // se armó.
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
    // El teclado va en `window` y no en el contenedor: en pantalla completa el
    // foco puede estar en el <body>, que no es descendiente del contenedor a
    // efectos de burbujeo de teclas.
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
