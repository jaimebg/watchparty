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
// A structural backstop for any form of "dragging" that never fires a cleanup
// (the mouse wheel over the range in Firefox is the one we know about today, but
// there is no reason to assume it is the only one): with no activity for this
// long, the watchdog below releases `drag` on its own.
const DRAG_WATCHDOG_MS = 2000
// The window that tells a click (play/pause) apart from a double-click
// (fullscreen). Without it, a double-click would send two play/pauses to the
// server and fill the chat with two system messages for every trip into
// fullscreen. 400 ms because the OS's real double-click sits around there
// (a little slower than crisp), not the ~220 ms of a button press: a smaller
// value lets slow double-clicks through as one click plus a double-click. The
// trade is that clicking the video takes those 400 ms to pause; the button and
// the space bar stay instant.
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
  // The active track according to hls.js, not according to the <select>: hls.js
  // is what picks it on load (DEFAULT=YES from the master playlist, or the
  // browser's language), so a select without a `value` would always render the
  // first option and lie about what is being heard.
  const [audioTrack, setAudioTrack] = useState(0)
  const [sub, setSub] = useState<number>(-1)
  // Volume and mute are PER VIEWER (never synchronized) and persist.
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
  // The value the bar shows while being dragged. Without this, the room clock's
  // 500 ms tick rewrites the position under the thumb and it runs away.
  const [drag, setDrag] = useState<number | null>(null)
  const draggingRef = useRef(false)
  // Stops the same seek being re-emitted when a keyup unrelated to the bar (say,
  // the space that resumes playback right after the thumb is released) re-enters
  // commitSeek before the new state that clears `drag` arrives. It resets at the
  // start of each new interaction and when the effect below finally clears
  // `drag`.
  const committedRef = useRef(false)
  // True only while a real pointer is still physically down, between its
  // onPointerDown and the onPointerUp/onPointerCancel/onBlur that releases it.
  // Without this the watchdog below could not tell a legitimate slow drag — the
  // thumb is still down even though the value has not changed for a while —
  // apart from the stuck state that arrived with NO thumb (the wheel), and it
  // would release `drag` mid-press.
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

  // On release, the bar stays where the thumb left it until the new state
  // arrives: putting it back to the room clock's old value sooner would show a
  // visible jump backwards during the round trip. While the thumb is still down
  // it is left alone. `committedRef` resets alongside `drag`: this is where the
  // interaction that set it to true ends.
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
      // The `hls.audioTrack` getter is read — the index into the track list,
      // which is exactly what the <select> indexes — and not the event's `id`:
      // that is a MediaPlaylist field and only matches the index while there is
      // a single audio group. SWITCHING responds instantly (the setter has
      // already moved the index) and SWITCHED confirms; without the first, the
      // select would bounce back to the old track until the switch landed.
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
    // Primitives rather than the object: the room's arrives fresh from every
    // fetch and would remount hls.js for no reason. The remount via
    // `key={epoch}` in Room.tsx is deliberate, and `epoch` is here so this
    // dependency list does not lie.
  }, [token, streamBase, media.epoch])

  // Space = global play/pause, unless focus is typing (chat) or on a control the
  // space belongs to (buttons, selects).
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

  // F = fullscreen, unless something is being typed. `spaceBelongsTo` will not
  // do here: it counts BUTTON as owning the key, and F does have to work with a
  // button focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return
      // `key` is still 'f' even with a modifier held: without this guard,
      // Ctrl+F/Cmd+F (the browser's find) would enter fullscreen and swallow the
      // preventDefault, leaving find useless while you are in the room.
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

  // A new state from the server (seek, play/pause, freeze/resume) unblocks an
  // immediate correction: the limit below should only slow the drift loop, never
  // an explicit user command.
  useEffect(() => { lastHardSeekRef.current = 0 }, [lastState?.state.updatedAt])

  useEffect(() => {
    const id = setInterval(() => {
      const video = videoRef.current
      if (!video || !lastState) return
      const target = targetPosition(lastState.state, lastState.serverNow, lastState.receivedAt, Date.now())

      // The loading signal is computed, not listened for: with the video paused
      // because the room is frozen, `playing` would never fire and the room
      // would wait for us until the cap ran out. Near the end there will never
      // be READY_AHEAD_S ahead, so that stretch always counts as ready.
      // durationSec of 0 means "unknown" (ffprobe did not report it), not "we
      // are already at the end": without the `> 0` guard it would read as the
      // end of every video and the ready signal would be off forever.
      const nearEnd = mediaRef.current.durationSec > 0 && target >= mediaRef.current.durationSec - READY_AHEAD_S
      const starved = !nearEnd && bufferedAhead(video.buffered, target) < READY_AHEAD_S
      if (starved !== bufferingRef.current) {
        bufferingRef.current = starved
        sendRef.current({ t: 'buffering', value: starved })
      }

      // Every hard correction throws away the buffer hls.js is filling. Without
      // this limit, a hiccup turns into a permanent stall: the buffer is reseeded
      // every 500 ms and never gets full enough to play.
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

  // A periodic re-render so the progress bar advances (the drift tick above only
  // touches refs and never triggers a render).
  useEffect(() => {
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const tracks = videoRef.current?.textTracks ?? []
    for (let i = 0; i < tracks.length; i++) tracks[i].mode = i === sub ? 'showing' : 'hidden'
  }, [sub])

  // `video.volume` is capped at 100% by spec, so going beyond that means routing
  // the element through a Web Audio GainNode. The graph is built lazily — only
  // when someone asks for more than 100% — because routing the element is
  // irreversible and there is no reason to pull someone who never amplifies into
  // the graph.
  //
  // And it is only built once the page has been "activated": an AudioContext
  // created before the user touches anything is born suspended, and a <video>
  // routed into a stopped context goes SILENT. When in doubt the context is
  // closed and the volume stays at its native cap, which is the harmless
  // failure.
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

  // With a stored volume above 100%, the effect above runs on mount — before any
  // gesture — and gives up without building the graph. This counter wakes it as
  // soon as the first interaction arrives, so the stored amplification is applied
  // without forcing anyone to touch the slider.
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
  // Re-armed on every onChange/onPointerDown and cancelled when the thumb is
  // released (commitSeek) or when a new interaction starts. If it fires with the
  // thumb still down it does nothing — that is a legitimate slow drag, not a
  // stuck state — so it only really releases the ownerless case (the wheel, or
  // whatever turns up tomorrow with the same shape).
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
    // The `keyup` of a key that never touches the bar (the space that resumes
    // after releasing the thumb, say) also lands here because focus stays on the
    // input. `committedRef` cuts that re-send: it is emitted once per
    // interaction, however many release events fire.
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
      {/* `crossOrigin` only when the video is on another origin: without it the
          browser discards a cross-origin <track> without a word. It is left off
          in the same-origin case so the usual path changes in no way — and
          'anonymous' is the right choice regardless, because these routes never
          look at cookies. */}
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
          // A pointercancel (the touch gesture being reinterpreted as a page
          // scroll, for instance) brings no pointerup: without this the thumb
          // would stay marked as down forever and the effect above would never
          // release `drag` again. It does not commit: a cancelled gesture is not
          // an intent to seek.
          onPointerCancel={() => { draggingRef.current = false; pointerDownRef.current = false; disarmDragWatchdog() }}
          // The native input only fires `change` on the arrows/Home/End/
          // PageUp/PageDown, the only keys that move a range's value — so this
          // already covers keyboard dragging with no separate onKeyDown. An
          // onKeyDown that marked *every* key would confuse space (which in this
          // global control is still play/pause and does not belong to the bar)
          // with the start of a drag, reopening the very re-send commitSeek
          // prevents above.
          onChange={e => { draggingRef.current = true; committedRef.current = false; setDrag(Number(e.target.value)); armDragWatchdog() }}
          // The wheel is NOT intercepted: on Firefox it moves the value without
          // going through pointerdown/up, but that is an anomaly the watchdog
          // already absorbs. Intercepting pre-emptively would block page scroll
          // exactly where it is needed to reach the chat on narrow screens
          // (<800px). The bar's visual wobble after a wheel is harmless and
          // self-corrects.
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
          // If focus leaves mid-press (rare, but possible) no keyup reaches this
          // input either: same reason as pointercancel.
          onBlur={() => { draggingRef.current = false; pointerDownRef.current = false; disarmDragWatchdog() }} />
        <span className="time-label" title={`Total duration ${formatClock(media.durationSec)}`}>−{formatClock(remaining)}</span>
        {/* With a single track the audio is muxed into the video segment itself
            and hls.js announces none: there is nothing to choose between. */}
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
