import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

// Safari still exposes the prefixed variants, and they are the only ones that
// exist in some versions still in use.
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
  active: boolean; cinema: boolean; toggle: () => void; exit: () => void
} {
  const [nativeOn, setNativeOn] = useState(false)
  // "Cinema mode": the iPhone will not put an HTML container fullscreen — only
  // the bare <video>, with no overlays — so there the window is filled from
  // inside the page. The floating chat stays visible.
  const [cinema, setCinema] = useState(false)
  const cinemaRef = useRef(cinema)
  cinemaRef.current = cinema

  // Leaving via Escape or the browser's own button never goes through `toggle`:
  // without this the CSS class would stay on with the screen already restored.
  useEffect(() => {
    const sync = () => setNativeOn(fullscreenElement() !== null)
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])

  // The browser does not close cinema mode: Escape has to be handled by hand.
  useEffect(() => {
    if (!cinema) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCinema(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cinema])

  // Without this, the document's scroll lets the header peek out underneath.
  useEffect(() => {
    if (!cinema) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [cinema])

  // A guard for a REAL unmount of Room (switching rooms, closing React's tab):
  // this does NOT cover the ffmpeg error screen, because there Room is still the
  // same mounted instance and only the JSX it returns changes, so this cleanup
  // effect never fires. `exit()` covers that case, which Room calls explicitly
  // on entering the error state.
  useEffect(() => () => { if (fullscreenElement()) exitFullscreen() }, [])

  // A forced exit for when JS itself decides it has to leave (Room entering the
  // error screen, say), rather than a reaction to a browser event. Native
  // fullscreen cleans itself up when the node leaves the tree, but cinema mode is
  // a `position: fixed` held up by this state: nothing turns it off on its own.
  const exit = useCallback(() => {
    if (fullscreenElement()) exitFullscreen()
    setCinema(false)
  }, [])

  const toggle = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (fullscreenElement()) { exitFullscreen(); return }
    if (cinemaRef.current) { setCinema(false); return }

    const legacy = el as LegacyElement
    const request = el.requestFullscreen?.bind(el) ?? legacy.webkitRequestFullscreen?.bind(legacy)
    if (!request) { setCinema(true); return }
    // It can reject (permission denied, a gesture not deemed trusted): rather
    // than leave a dead button, it falls back to cinema mode.
    Promise.resolve(request()).catch(() => setCinema(true))
  }, [ref])

  return { active: nativeOn || cinema, cinema, toggle, exit }
}
