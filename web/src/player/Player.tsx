import Hls from 'hls.js'
import { useEffect, useReducer, useRef, useState } from 'react'
import type { ClientMsg, PlaybackState, RoomInfo } from '../types'
import { computeCorrection, targetPosition } from '../sync/driftControl'
import { formatClock, spaceBelongsTo } from './format'

export interface LastState { state: PlaybackState; serverNow: number; receivedAt: number }

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

export function Player({ token, info, send, lastState }: {
  token: string; info: RoomInfo; send: (m: ClientMsg) => void; lastState: LastState | null
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [audioTracks, setAudioTracks] = useState<{ id: number; name: string }[]>([])
  const [sub, setSub] = useState<number>(-1)
  const [dragValue, setDragValue] = useState<number | null>(null)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)
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
  const togglePlay = () => sendRef.current({ t: pausedRef.current ? 'play' : 'pause' })

  useEffect(() => {
    const video = videoRef.current!
    const onWaiting = () => send({ t: 'buffering', value: true })
    const onPlaying = () => send({ t: 'buffering', value: false })
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)

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
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
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

  useEffect(() => {
    const id = setInterval(() => {
      const video = videoRef.current
      if (!video || !lastState) return
      const target = targetPosition(lastState.state, lastState.serverNow, lastState.receivedAt, Date.now())
      if (lastState.state.paused) {
        if (!video.paused) video.pause()
        if (Math.abs(video.currentTime - target) > 0.5) video.currentTime = target
        return
      }
      if (video.paused) void video.play().catch(() => {})
      const c = computeCorrection(target, video.currentTime)
      if (c.kind === 'rate') video.playbackRate = c.rate
      else if (c.kind === 'seek') { video.currentTime = c.to; video.playbackRate = 1 }
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
        <button className="btn-play" aria-label={paused ? 'Reproducir (espacio)' : 'Pausar (espacio)'}
          title={paused ? 'Reproducir (espacio)' : 'Pausar (espacio)'} onClick={togglePlay}>
          {paused ? <PlayIcon /> : <PauseIcon />}
        </button>
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
            style={{ background: `linear-gradient(90deg, #7c5cff ${pct}%, #2a2e37 ${pct}%)` }}
            value={shownPosition}
            onChange={e => setDragValue(Number(e.target.value))}
            onPointerUp={e => commitSeek(Number(e.currentTarget.value))}
            onTouchEnd={e => commitSeek(Number(e.currentTarget.value))}
            onKeyUp={e => commitSeek(Number(e.currentTarget.value))} />
        </div>
        <span className="time-label">{formatClock(info.durationSec)}</span>
        {mode === 'hls' && (
          <select onChange={e => { if (hlsRef.current) hlsRef.current.audioTrack = Number(e.target.value) }}>
            {audioTracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <select value={sub} onChange={e => setSub(Number(e.target.value))}>
          <option value={-1}>Sin subtítulos</option>
          {info.subtitles.map((s, i) => <option key={s.id} value={i}>{s.label}</option>)}
        </select>
      </div>
    </div>
  )
}
