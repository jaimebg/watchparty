import Hls from 'hls.js'
import { useEffect, useReducer, useRef, useState } from 'react'
import type { ClientMsg, PlaybackState, RoomInfo } from '../types'
import { bufferedAhead, computeCorrection, targetPosition } from '../sync/driftControl'
import { clampPosition, formatClock, MAX_VOLUME, parseClock, parseStoredVolume, positionGradient, spaceBelongsTo, volumeGradient } from './format'

export interface LastState { state: PlaybackState; serverNow: number; receivedAt: number }

const VOLUME_KEY = 'jbg-volume'
const MUTED_KEY = 'jbg-muted'
const READY_AHEAD_S = 2
const HARD_SEEK_MIN_INTERVAL_MS = 3000

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
    <path d="M8 5v14l11-7z" />
  </svg>
)
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
    <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
  </svg>
)
const VolumeIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" />
  </svg>
)
const MutedIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
    <path d="M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4-2.7-2.7z" />
  </svg>
)

export function Player({ token, info, send, lastState, welcomeCount }: {
  token: string; info: RoomInfo; send: (m: ClientMsg) => void; lastState: LastState | null
  welcomeCount: number
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [audioTracks, setAudioTracks] = useState<{ id: number; name: string }[]>([])
  const [sub, setSub] = useState<number>(-1)
  // Salto manual por texto ("1:27:00"): lo usa cualquiera, igual que la barra.
  const [jumpTo, setJumpTo] = useState('')
  const [jumpError, setJumpError] = useState<string | null>(null)
  // Volumen y silencio son POR ESPECTADOR (no se sincronizan) y persisten.
  const [volume, setVolume] = useState(() => parseStoredVolume(localStorage.getItem(VOLUME_KEY)))
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTED_KEY) === '1')
  // 'hls': hls.js/MSE (per-viewer audio track selection available).
  // 'native': no MSE, but the <video> element itself plays HLS (Safari/iOS) —
  // audio track selection has no native equivalent, so that selector hides.
  // 'unsupported': neither works; show a clear message instead of a dead player.
  const [mode, setMode] = useState<'hls' | 'native' | 'unsupported'>('hls')
  const [, tick] = useReducer((x: number) => x + 1, 0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const [gesture, setGesture] = useState(0)
  // Valor que enseña la barra mientras se arrastra. Sin esto, el tick de 500 ms
  // del reloj de sala reescribe la posición bajo el pulgar y el thumb se escapa.
  const [drag, setDrag] = useState<number | null>(null)
  const draggingRef = useRef(false)
  // Evita reemitir el mismo seek si un keyup ajeno a la barra (p. ej. el espacio
  // que reanuda la reproducción justo después de soltar el pulgar) vuelve a
  // entrar en commitSeek antes de que llegue el estado nuevo que limpia `drag`.
  // Se reinicia al empezar cada interacción nueva y cuando el efecto de abajo
  // por fin limpia `drag`.
  const committedRef = useRef(false)

  const paused = lastState?.state.paused ?? true
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const sendRef = useRef(send)
  sendRef.current = send
  const lastHardSeekRef = useRef(0)
  const bufferingRef = useRef(false)
  const infoRef = useRef(info)
  infoRef.current = info
  const togglePlay = () => sendRef.current({ t: pausedRef.current ? 'play' : 'pause' })

  const jump = () => {
    const position = parseClock(jumpTo)
    if (position === null) { setJumpError('Usa 1:27:00, 87:00 o 5220'); return }
    // El servidor recorta al rango igualmente, pero avisar aquí evita que un
    // dedazo mande la sala al final de la película sin que nadie sepa por qué.
    if (info.durationSec > 0 && position > info.durationSec) {
      setJumpError(`La película dura ${formatClock(info.durationSec)}`)
      return
    }
    setJumpError(null)
    setJumpTo('')
    sendRef.current({ t: 'seek', position })
  }

  // `welcome` is the one message meaning "the server just learned about me
  // from scratch": a fresh join, or ws.ts's transparent reconnect after a
  // drop. Either way the server's stall-tracking set was just rebuilt empty
  // for this socket, so a client that is still starved must re-send the true
  // edge next tick — without this, `bufferingRef.current` stays true from
  // before the drop and the room stops waiting for exactly the viewer whose
  // network just failed.
  useEffect(() => { bufferingRef.current = false }, [welcomeCount])

  // Al soltar, la barra se queda donde la dejó el pulgar hasta que llega el
  // estado nuevo: devolverla antes al valor viejo del reloj de sala daría un
  // salto atrás visible durante el viaje de ida y vuelta. Mientras el pulgar
  // siga abajo no se toca. Junto con `drag` se reinicia `committedRef`: aquí
  // termina el ciclo de la interacción que lo puso a true.
  useEffect(() => {
    if (draggingRef.current) return
    setDrag(null)
    committedRef.current = false
  }, [lastState])

  // The socket outlives this component: Room.tsx unmounts Player (and this
  // 500ms tick) to show the recovery screen on a `{t:'error'}` broadcast, but
  // the socket stays open. Without this, a viewer who was mid-buffer when the
  // error hit stays pinned in the server's buffering set forever, and every
  // later play/seek re-freezes the room for the full 20s cap for a socket
  // that will never emit `false` again.
  useEffect(() => () => {
    if (bufferingRef.current) sendRef.current({ t: 'buffering', value: false })
  }, [])

  useEffect(() => {
    const video = videoRef.current!

    let hls: Hls | null = null
    if (Hls.isSupported()) {
      hls = new Hls()
      hlsRef.current = hls
      hls.loadSource(`/stream/${token}/master.m3u8`)
      hls.attachMedia(video)
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () =>
        setAudioTracks(hls!.audioTracks.map((t, id) => ({ id, name: t.name }))))
      setMode('hls')
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = `/stream/${token}/master.m3u8`
      setMode('native')
    } else {
      setMode('unsupported')
    }

    return () => {
      if (hls) { hls.destroy(); hlsRef.current = null }
      else video.removeAttribute('src')
    }
  }, [token])

  // Espacio = play/pausa global, salvo que el foco esté escribiendo (chat) o
  // sobre un control al que el espacio pertenece (botones, selects).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const t = e.target as HTMLElement | null
      if (spaceBelongsTo(t?.tagName, (t as HTMLInputElement | null)?.type, t?.isContentEditable)) return
      e.preventDefault()
      togglePlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Un estado nuevo del servidor (seek, play/pausa, congelar/reanudar) desbloquea
  // una corrección inmediata: el límite de abajo solo debe frenar al bucle de
  // deriva, nunca a una orden explícita del usuario.
  useEffect(() => { lastHardSeekRef.current = 0 }, [lastState?.state.updatedAt])

  useEffect(() => {
    const id = setInterval(() => {
      const video = videoRef.current
      if (!video || !lastState) return
      const target = targetPosition(lastState.state, lastState.serverNow, lastState.receivedAt, Date.now())

      // La señal de carga se calcula, no se escucha: con el vídeo pausado porque
      // la sala está congelada, `playing` no dispararía nunca y la sala se
      // quedaría esperándonos hasta agotar el tope. Cerca del final nunca habrá
      // READY_AHEAD_S por delante, así que ese tramo cuenta siempre como listo.
      // durationSec en 0 significa «desconocida» (ffprobe no la reportó), no
      // «ya estamos al final»: sin la guarda `> 0` se leería como el final de
      // cualquier vídeo y la señal de listo quedaría desactivada para siempre.
      const nearEnd = infoRef.current.durationSec > 0 && target >= infoRef.current.durationSec - READY_AHEAD_S
      const starved = !nearEnd && bufferedAhead(video.buffered, target) < READY_AHEAD_S
      if (starved !== bufferingRef.current) {
        bufferingRef.current = starved
        sendRef.current({ t: 'buffering', value: starved })
      }

      // Cada corrección dura tira el buffer que hls.js está llenando. Sin este
      // límite, un hipo pasa a bloqueo permanente: se resiembra el buffer cada
      // 500 ms y nunca llega a haber suficiente para reproducir.
      const hardSeek = (to: number) => {
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) return
        if (Date.now() - lastHardSeekRef.current < HARD_SEEK_MIN_INTERVAL_MS) return
        lastHardSeekRef.current = Date.now()
        video.currentTime = to
      }

      if (lastState.state.paused || lastState.state.stalled) {
        if (!video.paused) video.pause()
        if (Math.abs(video.currentTime - target) > 0.5) hardSeek(target)
        return
      }
      if (video.paused) void video.play().catch(() => {})
      const c = computeCorrection(target, video.currentTime)
      if (c.kind === 'rate') video.playbackRate = c.rate
      else if (c.kind === 'seek') { hardSeek(c.to); video.playbackRate = 1 }
      else video.playbackRate = 1
    }, 500)
    return () => clearInterval(id)
  }, [lastState])

  // Re-render periódico para que la barra de progreso avance (el tick de deriva
  // de arriba solo toca refs y no dispara render).
  useEffect(() => {
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const tracks = videoRef.current?.textTracks ?? []
    for (let i = 0; i < tracks.length; i++) tracks[i].mode = i === sub ? 'showing' : 'hidden'
  }, [sub])

  // `video.volume` está topado al 100% por spec, así que pasar de ahí exige
  // enrutar el elemento por un GainNode de Web Audio. El grafo se monta perezoso
  // — solo cuando alguien pide más del 100% — porque enrutar el elemento es
  // irreversible y no hay motivo para meter en el grafo a quien nunca amplifica.
  //
  // Y se monta solo con la página ya "activada": un AudioContext creado antes de
  // que el usuario toque nada nace suspendido, y un <video> enrutado a un
  // contexto parado se queda MUDO. Ante la duda se cierra el contexto y el
  // volumen se queda en su tope nativo, que es el fallo inofensivo.
  const applyBoost = (v: number) => {
    const video = videoRef.current
    if (!video) return
    if (!gainRef.current) {
      if (v <= 1) return
      try {
        const ctx = new AudioContext()
        if (ctx.state === 'suspended') { void ctx.close().catch(() => {}); return }
        const gain = ctx.createGain()
        ctx.createMediaElementSource(video).connect(gain).connect(ctx.destination)
        audioCtxRef.current = ctx
        gainRef.current = gain
      } catch { return }
    }
    gainRef.current.gain.value = Math.max(1, v)
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = Math.min(1, volume)
    video.muted = muted
    applyBoost(volume)
    localStorage.setItem(VOLUME_KEY, String(volume))
    localStorage.setItem(MUTED_KEY, muted ? '1' : '0')
  }, [volume, muted, gesture])

  // Con un volumen guardado por encima del 100%, el efecto de arriba corre al
  // montar —antes de cualquier gesto— y se rinde sin montar el grafo. Este
  // contador lo despierta en cuanto llega la primera interacción, para que la
  // amplificación guardada se aplique sin obligar a tocar el slider.
  useEffect(() => {
    if (volume <= 1 || gainRef.current) return
    const onGesture = () => setGesture(g => g + 1)
    window.addEventListener('pointerdown', onGesture, { once: true })
    window.addEventListener('keydown', onGesture, { once: true })
    return () => {
      window.removeEventListener('pointerdown', onGesture)
      window.removeEventListener('keydown', onGesture)
    }
  }, [volume, gesture])

  useEffect(() => () => { void audioCtxRef.current?.close().catch(() => {}) }, [])

  const roomPosition = lastState
    ? Math.min(info.durationSec, targetPosition(lastState.state, lastState.serverNow, lastState.receivedAt, Date.now()))
    : 0
  const shownPosition = drag ?? roomPosition
  const remaining = Math.max(0, info.durationSec - shownPosition)

  const commitSeek = () => {
    draggingRef.current = false
    // El `keyup` de una tecla que no toca la barra (el espacio que reanuda tras
    // soltar el pulgar, por ejemplo) también llega aquí porque el foco se queda
    // en el input. `committedRef` corta ese reenvío: solo se emite una vez por
    // interacción, aunque el evento de soltar se dispare de más.
    if (drag === null || committedRef.current) return
    committedRef.current = true
    sendRef.current({ t: 'seek', position: clampPosition(drag, info.durationSec) })
  }

  if (mode === 'unsupported') {
    return (
      <div className="player">
        <p className="field-error">Este navegador no puede reproducir HLS. Prueba con una versión reciente de Chrome, Firefox o Safari.</p>
      </div>
    )
  }

  return (
    <div className="player">
      <video ref={videoRef} playsInline onClick={togglePlay}>
        {info.subtitles.map(s => (
          <track key={s.id} kind="subtitles" label={s.label} srcLang={s.lang} src={`/stream/${token}/sub_${s.id}.vtt`} />
        ))}
      </video>
      <div className="controls">
        <button type="button" className="btn-play" aria-label={paused ? 'Reproducir (espacio)' : 'Pausar (espacio)'}
          title={paused ? 'Reproducir (espacio)' : 'Pausar (espacio)'} onClick={togglePlay}>
          {paused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <div className="volume-group">
          <button type="button" className="btn-mute" aria-label={muted ? 'Quitar silencio' : 'Silenciar'}
            title={muted ? 'Quitar silencio' : 'Silenciar'} onClick={() => setMuted(m => !m)}>
            {muted || volume === 0 ? <MutedIcon /> : <VolumeIcon />}
          </button>
          <input className="seek volume" type="range" min={0} max={MAX_VOLUME} step={0.01}
            aria-label="Volumen"
            aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
            title={`Volumen ${Math.round((muted ? 0 : volume) * 100)}%`}
            style={{ background: volumeGradient(muted ? 0 : volume) }}
            value={muted ? 0 : volume}
            onChange={e => { setVolume(Number(e.target.value)); if (muted) setMuted(false) }} />
          {!muted && volume > 1 && <span className="volume-pct">{Math.round(volume * 100)}%</span>}
        </div>
        <span className="time-label">{formatClock(shownPosition)}</span>
        <input className="seek position" type="range" step={1}
          min={0} max={Math.max(1, Math.round(info.durationSec))}
          aria-label="Posición en la película"
          aria-valuetext={`${formatClock(shownPosition)} de ${formatClock(info.durationSec)}`}
          style={{ background: positionGradient(shownPosition, info.durationSec) }}
          value={Math.round(shownPosition)}
          onPointerDown={() => { draggingRef.current = true; committedRef.current = false }}
          // Un pointercancel (el gesto táctil se reinterpreta como scroll de la
          // página, por ejemplo) no trae pointerup: sin esto el pulgar quedaría
          // marcado como bajado para siempre y el efecto de arriba nunca
          // volvería a soltar `drag`. No comitea: un gesto cancelado no es una
          // intención de salto.
          onPointerCancel={() => { draggingRef.current = false }}
          // El input nativo solo dispara `change` con las flechas/Home/End/
          // PageUp/PageDown, que son las únicas teclas que mueven el valor de
          // un range — así que esto ya cubre el arrastre por teclado sin
          // necesidad de un onKeyDown aparte. Un onKeyDown que marcara *toda*
          // tecla confundiría al espacio (que en este control global sigue
          // siendo play/pausa, no pertenece a la barra) con el inicio de un
          // arrastre, reabriendo el mismo reenvío que commitSeek evita arriba.
          onChange={e => { draggingRef.current = true; committedRef.current = false; setDrag(Number(e.target.value)) }}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
          // Si el foco se va a media pulsación (raro, pero posible) tampoco
          // llega un keyup a este input: mismo motivo que pointercancel.
          onBlur={() => { draggingRef.current = false }} />
        <span className="time-label" title={`Duración total ${formatClock(info.durationSec)}`}>−{formatClock(remaining)}</span>
        <form className="jump-group" onSubmit={e => { e.preventDefault(); jump() }}>
          <label className="jump-label" htmlFor="jump-to">Ir a</label>
          <input id="jump-to" className="jump-input" value={jumpTo} placeholder="1:27:00"
            aria-label="Saltar a un momento de la película"
            aria-invalid={jumpError !== null}
            onChange={e => { setJumpTo(e.target.value); setJumpError(null) }} />
          <button type="submit" className="btn-jump" disabled={jumpTo.trim() === ''}>Saltar</button>
        </form>
        {/* Con una sola pista el audio va muxeado en el propio segmento de vídeo
            y hls.js no anuncia ninguna: no hay nada entre lo que elegir. */}
        {mode === 'hls' && audioTracks.length > 1 && (
          <select aria-label="Pista de audio" onChange={e => { if (hlsRef.current) hlsRef.current.audioTrack = Number(e.target.value) }}>
            {audioTracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <select aria-label="Subtítulos" value={sub} onChange={e => setSub(Number(e.target.value))}>
          <option value={-1}>Sin subtítulos</option>
          {info.subtitles.map((s, i) => <option key={s.id} value={i}>{s.label}</option>)}
        </select>
      </div>
      {jumpError && <p className="field-error" role="alert">{jumpError}</p>}
    </div>
  )
}
