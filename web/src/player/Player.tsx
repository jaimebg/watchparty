import Hls from 'hls.js'
import { useEffect, useReducer, useRef, useState } from 'react'
import type { ClientMsg, PlaybackState, RoomInfo } from '../types'
import { bufferedAhead, computeCorrection, targetPosition } from '../sync/driftControl'
import { formatClock, parseStoredVolume, spaceBelongsTo } from './format'

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
  token: string; info: RoomInfo; send: (m: ClientMsg) => void; lastState: LastState | null; welcomeCount: number
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [audioTracks, setAudioTracks] = useState<{ id: number; name: string }[]>([])
  const [sub, setSub] = useState<number>(-1)
  const [dragValue, setDragValue] = useState<number | null>(null)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
  // Volumen y silencio son POR ESPECTADOR (no se sincronizan) y persisten.
  const [volume, setVolume] = useState(() => parseStoredVolume(localStorage.getItem(VOLUME_KEY)))
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTED_KEY) === '1')
  // 'hls': hls.js/MSE (per-viewer audio track selection available).
  // 'native': no MSE, but the <video> element itself plays HLS (Safari/iOS) —
  // audio track selection has no native equivalent, so that selector hides.
  // 'unsupported': neither works; show a clear message instead of a dead player.
  const [mode, setMode] = useState<'hls' | 'native' | 'unsupported'>('hls')
  const [, tick] = useReducer((x: number) => x + 1, 0)

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

  // `welcome` is the one message meaning "the server just learned about me
  // from scratch": a fresh join, or ws.ts's transparent reconnect after a
  // drop. Either way the server's stall-tracking set was just rebuilt empty
  // for this socket, so a client that is still starved must re-send the true
  // edge next tick — without this, `bufferingRef.current` stays true from
  // before the drop and the room stops waiting for exactly the viewer whose
  // network just failed.
  useEffect(() => { bufferingRef.current = false }, [welcomeCount])

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

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = volume
    video.muted = muted
    localStorage.setItem(VOLUME_KEY, String(volume))
    localStorage.setItem(MUTED_KEY, muted ? '1' : '0')
  }, [volume, muted])

  // Dragging the slider must not spam a `seek` per pixel: onChange only updates
  // the locally-displayed position (dragValue), and a single seek is sent when
  // the interaction ends (pointer/touch release or keyboard commit).
  const commitSeek = (pos: number) => {
    send({ t: 'seek', position: pos })
    setDragValue(null)
  }
  const displayedPosition = lastState
    ? Math.min(info.durationSec, targetPosition(lastState.state, lastState.serverNow, lastState.receivedAt, Date.now()))
    : 0
  const shownPosition = dragValue ?? displayedPosition
  const pct = info.durationSec > 0 ? (shownPosition / info.durationSec) * 100 : 0

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
          <input className="seek volume" type="range" min={0} max={1} step={0.01}
            aria-label="Volumen"
            style={{ background: `linear-gradient(90deg, var(--seek-fill) ${(muted ? 0 : volume) * 100}%, var(--seek-track) ${(muted ? 0 : volume) * 100}%)` }}
            value={muted ? 0 : volume}
            onChange={e => { setVolume(Number(e.target.value)); if (muted) setMuted(false) }} />
        </div>
        <span className="time-label">{formatClock(shownPosition)}</span>
        <div className="seek-wrap"
          onMouseMove={e => {
            const r = e.currentTarget.getBoundingClientRect()
            const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
            setHover({ x: e.clientX - r.left, t: frac * info.durationSec })
          }}
          onMouseLeave={() => setHover(null)}>
          {hover !== null && (
            <div className="seek-tooltip" style={{ left: `${hover.x}px` }}>{formatClock(hover.t)}</div>
          )}
          <input className="seek" type="range" min={0} max={info.durationSec} step={0.1}
            aria-label="Posición del vídeo"
            style={{ background: `linear-gradient(90deg, var(--seek-fill) ${pct}%, var(--seek-track) ${pct}%)` }}
            value={shownPosition}
            onChange={e => setDragValue(Number(e.target.value))}
            onPointerUp={e => commitSeek(Number(e.currentTarget.value))}
            onTouchEnd={e => commitSeek(Number(e.currentTarget.value))}
            onKeyUp={e => commitSeek(Number(e.currentTarget.value))} />
        </div>
        <span className="time-label">{formatClock(info.durationSec)}</span>
        {mode === 'hls' && (
          <select aria-label="Pista de audio" onChange={e => { if (hlsRef.current) hlsRef.current.audioTrack = Number(e.target.value) }}>
            {audioTracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <select aria-label="Subtítulos" value={sub} onChange={e => setSub(Number(e.target.value))}>
          <option value={-1}>Sin subtítulos</option>
          {info.subtitles.map((s, i) => <option key={s.id} value={i}>{s.label}</option>)}
        </select>
      </div>
    </div>
  )
}
