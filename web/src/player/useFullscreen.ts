import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

// Safari sigue exponiendo las variantes con prefijo, y son las únicas que
// existen en algunas versiones que aún se usan.
interface LegacyElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void
}
interface LegacyDocument extends Document {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

const legacyDoc = (): LegacyDocument => document as LegacyDocument

function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? legacyDoc().webkitFullscreenElement ?? null
}

function exitFullscreen(): void {
  if (document.exitFullscreen) { void document.exitFullscreen().catch(() => {}); return }
  legacyDoc().webkitExitFullscreen?.()
}

export function useFullscreen(ref: RefObject<HTMLElement | null>): {
  active: boolean; cinema: boolean; toggle: () => void
} {
  const [nativeOn, setNativeOn] = useState(false)
  // «Modo cine»: el iPhone no deja poner un contenedor HTML a pantalla completa
  // —solo el <video> desnudo, sin overlays—, así que allí se ocupa la ventana
  // desde dentro de la página. El chat flotante sigue viéndose.
  const [cinema, setCinema] = useState(false)
  const cinemaRef = useRef(cinema)
  cinemaRef.current = cinema

  // Salir con Escape o con el botón del navegador no pasa por `toggle`: sin
  // esto la clase CSS se quedaría puesta con la pantalla ya restaurada.
  useEffect(() => {
    const sync = () => setNativeOn(fullscreenElement() !== null)
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])

  // El modo cine no lo cierra el navegador: hay que atender Escape a mano.
  useEffect(() => {
    if (!cinema) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCinema(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cinema])

  // Sin esto, el scroll del documento deja asomar la cabecera por debajo.
  useEffect(() => {
    if (!cinema) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [cinema])

  // Room desmonta el player entero cuando ffmpeg falla: dejar la pestaña en
  // pantalla completa sobre la pantalla de error sería una trampa sin salida
  // visible.
  useEffect(() => () => { if (fullscreenElement()) exitFullscreen() }, [])

  const toggle = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (fullscreenElement()) { exitFullscreen(); return }
    if (cinemaRef.current) { setCinema(false); return }

    const legacy = el as LegacyElement
    const request = el.requestFullscreen?.bind(el) ?? legacy.webkitRequestFullscreen?.bind(legacy)
    if (!request) { setCinema(true); return }
    // Puede rechazar (permiso denegado, gesto no considerado de confianza): en
    // vez de dejar un botón muerto, se cae al modo cine.
    Promise.resolve(request()).catch(() => setCinema(true))
  }, [ref])

  return { active: nativeOn || cinema, cinema, toggle }
}
