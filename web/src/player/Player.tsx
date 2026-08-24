import Hls from 'hls.js'
import { useEffect, useReducer, useRef, useState } from 'react'
import type { ClientMsg, PlaybackState, RoomMediaInfo } from '../types'
import { bufferedAhead, computeCorrection, targetPosition } from '../sync/driftControl'
import { clampPosition, formatClock, isTypingTarget, MAX_VOLUME, parseStoredVolume, positionGradient, spaceBelongsTo, volumeGradient } from './format'
import { streamUrl } from './streamUrl'

export interface LastState { state: PlaybackState; serverNow: number; receivedAt: number }

const VOLUME_KEY = 'jbg-volume'
const MUTED_KEY = 'jbg-muted'
const READY_AHEAD_S = 2
const HARD_SEEK_MIN_INTERVAL_MS = 3000
// Cierre estructural para cualquier forma de "dragging" que no dispare
// limpieza (la rueda del ratón sobre el range en Firefox es la que conocemos
// hoy, pero no hay por qué asumir que es la única): sin actividad durante
// este margen, el watchdog de más abajo suelta `drag` solo.
const DRAG_WATCHDOG_MS = 2000
// Ventana para distinguir un clic (play/pausa) de un doble clic (pantalla
// completa). Sin ella, el doble clic mandaría dos play/pausa al servidor y
// llenaría el chat de dos mensajes de sistema por cada entrada a pantalla
// completa. 400ms porque el doble clic real del sistema operativo ronda ahí
// (algo más lento que corta), no los ~220ms de una pulsación de botón: un
// valor menor deja pasar dobles clics lentos como un solo clic + doble clic.
// A cambio, el clic sobre el vídeo tarda esos 400ms en pausar; el botón y la
// barra espaciadora, en cambio, siguen siendo instantáneos.
const DOUBLE_CLICK_MS = 400

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
const EnterFullscreenIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
    <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
  </svg>
)
const ExitFullscreenIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
    <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
  </svg>
)

export function Player({ token, media, streamBase, send, lastState, welcomeCount, fullscreen, onToggleFullscreen }: {
  token: string; media: RoomMediaInfo; streamBase: string
  send: (m: ClientMsg) => void; lastState: LastState | null
  welcomeCount: number
  fullscreen: boolean
  onToggleFullscreen: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [audioTracks, setAudioTracks] = useState<{ id: number; name: string }[]>([])
  // Pista activa según hls.js, no según el <select>: es él quien la elige al
  // cargar (DEFAULT=YES de la playlist maestra, o el idioma del navegador), así
  // que un select sin `value` pintaría siempre la primera opción y mentiría
  // sobre lo que se está oyendo.
  const [audioTrack, setAudioTrack] = useState(0)
  const [sub, setSub] = useState<number>(-1)
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
  // Verdadero solo mientras un puntero real sigue físicamente abajo, entre su
  // onPointerDown y el onPointerUp/onPointerCancel/onBlur que lo suelta. Sin
  // esto el watchdog de abajo no podría distinguir un arrastre lento legítimo
  // -el pulgar sigue abajo aunque el valor no cambie un rato- del enganche
  // que llegó SIN pulgar (la rueda), y soltaría `drag` a media pulsación.
  const pointerDownRef = useRef(false)
  const dragWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const paused = lastState?.state.paused ?? true
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const sendRef = useRef(send)
  sendRef.current = send
  const toggleFsRef = useRef(onToggleFullscreen)
  toggleFsRef.current = onToggleFullscreen
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastHardSeekRef = useRef(0)
  const bufferingRef = useRef(false)
  const mediaRef = useRef(media)
  mediaRef.current = media
  const togglePlay = () => sendRef.current({ t: pausedRef.current ? 'play' : 'pause' })

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

    const master = streamUrl(streamBase, token, media.epoch, 'master.m3u8')

    let hls: Hls | null = null
    if (Hls.isSupported()) {
      hls = new Hls()
      hlsRef.current = hls
      hls.loadSource(master)
      hls.attachMedia(video)
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        setAudioTracks(hls!.audioTracks.map((t, id) => ({ id, name: t.name })))
        setAudioTrack(hls!.audioTrack)
      })
      // Se lee el getter `hls.audioTrack` —índice en la lista de pistas, que es
      // justo lo que indexa el <select>— y no el `id` del evento: ese es un campo
      // de MediaPlaylist y solo coincide con el índice mientras haya un único
      // grupo de audio. SWITCHING responde al instante (el setter ya ha movido el
      // índice) y SWITCHED confirma; sin el primero, el select rebotaría a la
      // pista vieja hasta que el cambio aterrizara.
      const syncTrack = () => setAudioTrack(hls!.audioTrack)
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHING, syncTrack)
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, syncTrack)
      setMode('hls')
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = master
      setMode('native')
    } else {
      setMode('unsupported')
    }

    return () => {
      if (hls) { hls.destroy(); hlsRef.current = null }
      else video.removeAttribute('src')
    }
    // Primitivas y no el objeto: el de la sala llega nuevo de cada fetch y
    // remontaría hls.js sin motivo. El remonte por `key={epoch}` en Room.tsx
    // sí es intencionado, y `epoch` está aquí para que la lista no mienta.
  }, [token, streamBase, media.epoch])

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

  // F = pantalla completa, salvo que se esté escribiendo. Aquí no vale
  // `spaceBelongsTo`: cuenta BUTTON como propietario de la tecla, y la F sí
  // debe funcionar con un botón enfocado.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return
      // `key` sigue siendo 'f' aunque haya un modificador pulsado: sin esta
      // guarda, Ctrl+F/Cmd+F (buscar del navegador) entraría en pantalla
      // completa y se tragaría el preventDefault, dejando el buscador
      // inservible mientras se está en la sala.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (isTypingTarget(t?.tagName, (t as HTMLInputElement | null)?.type, t?.isContentEditable)) return
      e.preventDefault()
      toggleFsRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => () => { if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current) }, [])

  const onVideoClick = () => {
    if (clickTimerRef.current !== null) return
    clickTimerRef.current = setTimeout(() => { clickTimerRef.current = null; togglePlay() }, DOUBLE_CLICK_MS)
  }

  const onVideoDoubleClick = () => {
    if (clickTimerRef.current !== null) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null }
    toggleFsRef.current()
  }

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
      const nearEnd = mediaRef.current.durationSec > 0 && target >= mediaRef.current.durationSec - READY_AHEAD_S
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

  const disarmDragWatchdog = () => {
    if (dragWatchdogRef.current === null) return
    clearTimeout(dragWatchdogRef.current)
    dragWatchdogRef.current = null
  }
  // Se rearma en cada onChange/onPointerDown y se cancela al soltar el pulgar
  // (commitSeek) o al empezar una interacción nueva. Si dispara con el pulgar
  // todavía abajo no hace nada -eso es un arrastre lento legítimo, no un
  // enganche-, así que solo libera de verdad el enganche sin dueño (rueda,
  // o lo que venga mañana con la misma forma).
  const armDragWatchdog = () => {
    disarmDragWatchdog()
    dragWatchdogRef.current = setTimeout(() => {
      dragWatchdogRef.current = null
      if (pointerDownRef.current) return
      draggingRef.current = false
      setDrag(null)
      committedRef.current = false
    }, DRAG_WATCHDOG_MS)
  }
  useEffect(() => () => disarmDragWatchdog(), [])

  const roomPosition = lastState
    ? Math.min(media.durationSec, targetPosition(lastState.state, lastState.serverNow, lastState.receivedAt, Date.now()))
    : 0
  const shownPosition = drag ?? roomPosition
  const remaining = Math.max(0, media.durationSec - shownPosition)

  const commitSeek = () => {
    draggingRef.current = false
    pointerDownRef.current = false
    disarmDragWatchdog()
    // El `keyup` de una tecla que no toca la barra (el espacio que reanuda tras
    // soltar el pulgar, por ejemplo) también llega aquí porque el foco se queda
    // en el input. `committedRef` corta ese reenvío: solo se emite una vez por
    // interacción, aunque el evento de soltar se dispare de más.
    if (drag === null || committedRef.current) return
    committedRef.current = true
    sendRef.current({ t: 'seek', position: clampPosition(drag, media.durationSec) })
  }

  if (mode === 'unsupported') {
    return (
      <div className="player">
        <p className="field-error">This browser can't play HLS. Try a recent version of Chrome, Firefox or Safari.</p>
      </div>
    )
  }

  return (
    <div className="player">
      {/* `crossOrigin` solo con el vídeo en otro origen: un <track> cross-origin
          sin él lo descarta el navegador sin decir nada. Se deja fuera en el caso
          de mismo origen para no cambiar en nada el camino de siempre — y
          'anonymous' es lo que toca de todas formas, porque estas rutas no
          miran cookies. */}
      <video ref={videoRef} playsInline crossOrigin={streamBase ? 'anonymous' : undefined}
        onClick={onVideoClick} onDoubleClick={onVideoDoubleClick}>
        {media.subtitles.map(s => (
          <track key={s.id} kind="subtitles" label={s.label} srcLang={s.lang}
            src={streamUrl(streamBase, token, media.epoch, `sub_${s.id}.vtt`)} />
        ))}
      </video>
      <div className="controls">
        <button type="button" className="btn-play" aria-label={paused ? 'Play (space)' : 'Pause (space)'}
          title={paused ? 'Play (space)' : 'Pause (space)'} onClick={togglePlay}>
          {paused ? <PlayIcon /> : <PauseIcon />}
        </button>
        <div className="volume-group">
          <button type="button" className="btn-mute" aria-label={muted ? 'Unmute' : 'Mute'}
            title={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted(m => !m)}>
            {muted || volume === 0 ? <MutedIcon /> : <VolumeIcon />}
          </button>
          <input className="seek volume" type="range" min={0} max={MAX_VOLUME} step={0.01}
            aria-label="Volume"
            aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
            title={`Volume ${Math.round((muted ? 0 : volume) * 100)}%`}
            style={{ background: volumeGradient(muted ? 0 : volume) }}
            value={muted ? 0 : volume}
            onChange={e => { setVolume(Number(e.target.value)); if (muted) setMuted(false) }} />
          {!muted && volume > 1 && <span className="volume-pct">{Math.round(volume * 100)}%</span>}
        </div>
        <span className="time-label">{formatClock(shownPosition)}</span>
        <input className="seek position" type="range" step={1}
          min={0} max={Math.max(1, Math.round(media.durationSec))}
          disabled={media.durationSec <= 0}
          aria-label="Position in movie"
          aria-valuetext={`${formatClock(shownPosition)} of ${formatClock(media.durationSec)}`}
          style={{ background: positionGradient(shownPosition, media.durationSec) }}
          value={Math.round(shownPosition)}
          onPointerDown={() => { draggingRef.current = true; committedRef.current = false; pointerDownRef.current = true; armDragWatchdog() }}
          // Un pointercancel (el gesto táctil se reinterpreta como scroll de la
          // página, por ejemplo) no trae pointerup: sin esto el pulgar quedaría
          // marcado como bajado para siempre y el efecto de arriba nunca
          // volvería a soltar `drag`. No comitea: un gesto cancelado no es una
          // intención de salto.
          onPointerCancel={() => { draggingRef.current = false; pointerDownRef.current = false; disarmDragWatchdog() }}
          // El input nativo solo dispara `change` con las flechas/Home/End/
          // PageUp/PageDown, que son las únicas teclas que mueven el valor de
          // un range — así que esto ya cubre el arrastre por teclado sin
          // necesidad de un onKeyDown aparte. Un onKeyDown que marcara *toda*
          // tecla confundiría al espacio (que en este control global sigue
          // siendo play/pausa, no pertenece a la barra) con el inicio de un
          // arrastre, reabriendo el mismo reenvío que commitSeek evita arriba.
          onChange={e => { draggingRef.current = true; committedRef.current = false; setDrag(Number(e.target.value)); armDragWatchdog() }}
          // NO interceptamos la rueda: en Firefox mueve el valor sin pasar por
          // pointerdown/up, pero eso es una anomalía que el watchdog ya absorbe.
          // Interceptar preventivamente bloquearía el scroll de la página justo
          // donde hace falta para alcanzar el chat en pantallas estrechas (<800px).
          // El temblor visual de la barra tras la rueda es inofensivo y se autocorrige.
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
          // Si el foco se va a media pulsación (raro, pero posible) tampoco
          // llega un keyup a este input: mismo motivo que pointercancel.
          onBlur={() => { draggingRef.current = false; pointerDownRef.current = false; disarmDragWatchdog() }} />
        <span className="time-label" title={`Total duration ${formatClock(media.durationSec)}`}>−{formatClock(remaining)}</span>
        {/* Con una sola pista el audio va muxeado en el propio segmento de vídeo
            y hls.js no anuncia ninguna: no hay nada entre lo que elegir. */}
        {mode === 'hls' && audioTracks.length > 1 && (
          <select aria-label="Audio track" value={audioTrack}
            onChange={e => { if (hlsRef.current) hlsRef.current.audioTrack = Number(e.target.value) }}>
            {audioTracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <select aria-label="Subtitles" value={sub} onChange={e => setSub(Number(e.target.value))}>
          <option value={-1}>No subtitles</option>
          {media.subtitles.map((s, i) => <option key={s.id} value={i}>{s.label}</option>)}
        </select>
        <button type="button" className="btn-fullscreen"
          aria-label={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
          title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
          onClick={onToggleFullscreen}>
          {fullscreen ? <ExitFullscreenIcon /> : <EnterFullscreenIcon />}
        </button>
      </div>
    </div>
  )
}
