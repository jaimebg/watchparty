import Hls from 'hls.js'
import { useEffect, useReducer, useRef, useState } from 'react'
import type { ClientMsg, PlaybackState, RoomInfo } from '../types'
import { computeCorrection, targetPosition } from '../sync/driftControl'

export interface LastState { state: PlaybackState; serverNow: number; receivedAt: number }

export function Player({ token, info, send, lastState }: {
  token: string; info: RoomInfo; send: (m: ClientMsg) => void; lastState: LastState | null
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [audioTracks, setAudioTracks] = useState<{ id: number; name: string }[]>([])
  const [sub, setSub] = useState<number>(-1)
  const [, tick] = useReducer((x: number) => x + 1, 0)

  useEffect(() => {
    const video = videoRef.current!
    const hls = new Hls()
    hlsRef.current = hls
    hls.loadSource(`/stream/${token}/master.m3u8`)
    hls.attachMedia(video)
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () =>
      setAudioTracks(hls.audioTracks.map((t, id) => ({ id, name: t.name }))))
    const onWaiting = () => send({ t: 'buffering', value: true })
    const onPlaying = () => send({ t: 'buffering', value: false })
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    return () => { hls.destroy(); video.removeEventListener('waiting', onWaiting); video.removeEventListener('playing', onPlaying) }
  }, [token])

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

  const seekTo = (pos: number) => send({ t: 'seek', position: pos })

  return (
    <div className="player">
      <video ref={videoRef} playsInline>
        {info.subtitles.map(s => (
          <track key={s.id} kind="subtitles" label={s.label} srcLang={s.lang} src={`/stream/${token}/sub_${s.id}.vtt`} />
        ))}
      </video>
      <div className="controls">
        <button onClick={() => send({ t: lastState?.state.paused ? 'play' : 'pause' })}>
          {lastState?.state.paused ? '▶️' : '⏸'}
        </button>
        <input type="range" min={0} max={info.durationSec} step={1}
          value={lastState ? Math.min(info.durationSec, targetPosition(lastState.state, lastState.serverNow, lastState.receivedAt, Date.now())) : 0}
          onChange={e => seekTo(Number(e.target.value))} />
        <select onChange={e => { if (hlsRef.current) hlsRef.current.audioTrack = Number(e.target.value) }}>
          {audioTracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={sub} onChange={e => setSub(Number(e.target.value))}>
          <option value={-1}>Sin subtítulos</option>
          {info.subtitles.map((s, i) => <option key={s.id} value={i}>{s.label}</option>)}
        </select>
      </div>
    </div>
  )
}
