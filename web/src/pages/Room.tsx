import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { getRoom, getStatus } from '../api'
import { connectRoom, nextDelay } from '../ws'
import { Player, type LastState } from '../player/Player'
import { useFullscreen } from '../player/useFullscreen'
import { useIdleChrome } from '../player/useIdleChrome'
import { isTypingTarget } from '../player/format'
import { ChatPanel } from '../chat/ChatPanel'
import { ReactionsBar } from '../chat/ReactionsBar'
import { ReactionOverlay } from '../chat/ReactionOverlay'
import { chatReducer, dropFlash, dropReaction, initialChat, type ChatState } from '../chat/chatStore'
import { MetaModal } from '../MetaModal'
import { MediaPicker } from '../MediaPicker'
import { roomLink } from './roomToken'
import type { ClientMsg, RoomInfo, ServerMsg } from '../types'

const NAME_KEY = 'jbg-name'
const STATUS_POLL_MS = 30_000
const COPIED_FEEDBACK_MS = 2000

const InfoIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
  </svg>
)
const LinkIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
    <path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z" />
  </svg>
)
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
    <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
  </svg>
)

// Superset of ServerMsg with a UI-only action to retire a reaction once its
// float-up animation finishes. Keeps chatReducer's exported signature (tested
// directly in chatStore.test.ts) limited to ServerMsg, as the brief requires.
type RoomChatAction =
  | ServerMsg
  | { t: 'drop-reaction'; id: number }
  | { t: 'drop-flash'; pid: string; id: number }

function roomChatReducer(s: ChatState, a: RoomChatAction): ChatState {
  if (a.t === 'drop-reaction') return dropReaction(s, a.id)
  if (a.t === 'drop-flash') return dropFlash(s, a.pid, a.id)
  return chatReducer(s, a)
}

export function Room({ token }: { token: string }) {
  const [name, setName] = useState<string | null>(() => localStorage.getItem(NAME_KEY))
  const [nameInput, setNameInput] = useState('')
  const [info, setInfo] = useState<RoomInfo | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [lastState, setLastState] = useState<LastState | null>(null)
  // Counts every `welcome`, the one message meaning "the server just learned
  // about me from scratch" (fresh join, or a transparent ws.ts reconnect).
  // Player resets its buffering edge-detector on every bump so a client still
  // starved after a reconnect re-announces itself instead of staying silent —
  // the server's stall-tracking set was just rebuilt empty for this socket.
  const [welcomeCount, setWelcomeCount] = useState(0)
  const [tunnelDown, setTunnelDown] = useState(false)
  // Host only: /api/status answers 401 to guests. It is the same signal already
  // used for the tunnel link, now with a name of its own, because it also
  // governs the choose-movie button.
  const [isHost, setIsHost] = useState(false)
  // Only the host knows it: /api/status answers 401 to guests. That is why the
  // copy button appears only in the host's tab (localhost), which is exactly the
  // one that needs the tunnel link rather than its own URL.
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle')
  const [wsError, setWsError] = useState<string[] | null>(null)
  const [chat, dispatchChat] = useReducer(roomChatReducer, initialChat)
  const [showMeta, setShowMeta] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const sendRef = useRef<(m: ClientMsg) => void>(() => {})
  const gridRef = useRef<HTMLDivElement>(null)
  const { active: fullscreen, cinema, toggle: toggleFullscreen, exit: exitFullscreen } = useFullscreen(gridRef)

  // The timer consults this when it expires: with the room paused or someone
  // typing, the chrome stays.
  const pausedRef = useRef(true)
  pausedRef.current = lastState?.state.paused ?? true
  const { awake: chromeAwake, wake: wakeChrome } = useIdleChrome({
    enabled: fullscreen,
    container: gridRef,
    isBlocked: () => {
      if (pausedRef.current) return true
      const el = document.activeElement as HTMLElement | null
      return isTypingTarget(el?.tagName, (el as HTMLInputElement | null)?.type, el?.isContentEditable)
    },
  })

  // A new message wakes the chrome without touching the mouse. System ones
  // ("X paused") do not count: that is noise, not conversation. The first pass is
  // ignored so the history arriving in the `welcome` does not count as new.
  const lastEntryRef = useRef<string | null>(null)
  useEffect(() => {
    const last = chat.entries.at(-1)
    const previous = lastEntryRef.current
    lastEntryRef.current = last?.id ?? null
    if (!last || previous === null || last.id === previous) return
    if (last.kind === 'system') return
    wakeChrome()
  }, [chat.entries, wakeChrome])

  const shareUrl = tunnelUrl ? roomLink(tunnelUrl, token) : null

  const copyLink = async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied('ok')
    } catch {
      // No clipboard (insecure context, permission denied): the link is shown
      // to copy by hand rather than failing silently.
      setCopied('fail')
    }
  }

  useEffect(() => {
    if (copied !== 'ok') return
    const id = setTimeout(() => setCopied('idle'), COPIED_FEEDBACK_MS)
    return () => clearTimeout(id)
  }, [copied])

  // The retry calls itself, and `reloadInfo` cannot depend on its own identity:
  // changing it would re-run the socket effect (reconnecting throws away chat and
  // presence). The ref breaks that cycle.
  const reloadRef = useRef<() => Promise<void>>(async () => {})
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryAttemptRef = useRef(0)

  // `getRoom` throws the same on a 404 as on a 502 from the tunnel or a network
  // drop, and this no longer runs only on mount: it runs mid-session on every
  // movie change. Only the 404 means "this room no longer exists"; giving the
  // room up for lost on a passing error would render "Room not found" and, along
  // the way, close the socket through the guard in the effect below, leaving the
  // guest with no chat, no presence and nothing to retry. Anything transient
  // leaves the `info` already on screen alone and retries itself, with the same
  // backoff the socket's reconnect uses.
  const reloadInfo = useCallback(async () => {
    try {
      setInfo(await getRoom(token))
      if (retryRef.current !== null) { clearTimeout(retryRef.current); retryRef.current = null }
      retryAttemptRef.current = 0
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) { setNotFound(true); return }
      // One retry in flight: several {t:'media'} in a row with the network down
      // must not chain timers.
      if (retryRef.current !== null) return
      retryRef.current = setTimeout(() => {
        retryRef.current = null
        void reloadRef.current()
      }, nextDelay(retryAttemptRef.current++))
    }
  }, [token])
  reloadRef.current = reloadInfo

  useEffect(() => { void reloadInfo() }, [reloadInfo])
  useEffect(() => () => { if (retryRef.current !== null) clearTimeout(retryRef.current) }, [])

  // A mirror of `info` for the socket callback: were it in the effect's
  // dependencies, every refresh would reconnect the socket.
  const infoRef = useRef<RoomInfo | null>(null)
  infoRef.current = info

  useEffect(() => {
    if (!name || notFound) return
    const conn = connectRoom(token, name, m => {
      dispatchChat(m)
      if (m.t === 'welcome' || m.t === 'state') {
        setLastState({ state: m.state, serverNow: m.serverNow, receivedAt: Date.now() })
      }
      if (m.t === 'welcome') {
        setWelcomeCount(c => c + 1)
        // Only whoever had the socket open at the instant of the change gets
        // {t:'media'}: the guest still at the name prompt never sees it, and
        // neither does one that was reconnecting. Without this they stay on the
        // previous generation forever: a "the host is choosing" card in a room
        // that already has a movie, or a player asking for URLs that now answer
        // 410, black and silent. The `welcome` carries the live generation, so it
        // is compared and refreshed when they do not match. With `info` not in
        // yet there is nothing to compare: the mount's REST request is in flight
        // (or retrying) and will bring that same generation, and asking here
        // would be one request too many on every normal start.
        const known = infoRef.current
        if (known && m.epoch !== (known.media?.epoch ?? null)) {
          // The same treatment as the {t:'media'} this client missed, `wsError`
          // included: whatever ffmpeg failure it might be carrying belonged to
          // the previous generation.
          setWsError(null)
          void reloadInfo()
        }
      }
      if (m.t === 'error') setWsError(m.log)
      if (m.t === 'media') {
        // A single refresh path, the host who triggered it included: the POST
        // updates no state on its own, so there are no two routes that could
        // drift apart. `wsError` is cleared because the ffmpeg failure belonged
        // to the previous movie.
        setWsError(null)
        void reloadInfo()
      }
    })
    sendRef.current = conn.send
    return () => conn.close()
  }, [token, name, notFound, reloadInfo])

  // Presence: announces when the tab goes to the background or comes back
  // (Page Visibility API).
  useEffect(() => {
    const onVis = () => sendRef.current({ t: 'visibility', active: document.visibilityState === 'visible' })
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // The tunnel-down banner: only the host gets a response from /api/status
  // (guests get a 401, so it is skipped silently).
  useEffect(() => {
    let cancelled = false
    let polling = true
    const poll = () => {
      if (!polling || cancelled) return
      getStatus()
        .then(s => {
          if (cancelled) return
          setIsHost(true)
          setTunnelUrl(s.tunnelUrl)
          setTunnelDown(s.tunnelUrl === null)
        })
        // 401: this is a guest. Polling stops, the tunnel link is not shown and
        // the choose-movie button never appears.
        .catch(() => { polling = false; setIsHost(false) })
    }
    poll()
    const id = setInterval(poll, STATUS_POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // A ffmpeg failure can happen either before the client ever connects
  // (info.error, from the initial REST fetch) or mid-session, reported over
  // the socket as {t:'error'}; both render the same recovery screen. It is
  // computed up here — before the early returns — because the Rules of Hooks
  // require useEffect to be called in the same order every time; `info` may
  // still be `null` at this point.
  const errorLog = wsError ?? info?.error

  // Cinema mode does not clean itself up the way native fullscreen does (which
  // exits on its own the moment the node leaves the tree): it is a
  // `position: fixed` held up by React state, and Room does not unmount when it
  // enters the error state, it only changes the JSX it returns. Without this,
  // cinema stays `true` and the body keeps its scroll locked over the error
  // screen, with the "Retry" button possibly out of reach and no way out but the
  // Escape key that the iPhone — the only place with cinema mode — does not
  // have.
  useEffect(() => {
    if (errorLog) exitFullscreen()
  }, [errorLog, exitFullscreen])

  if (notFound) {
    return (
      <main className="page page--gate">
        <header className="masthead">
          <p className="eyebrow">Watchparty</p>
          <h1>Room not found</h1>
          <div className="marquee-rule" aria-hidden="true" />
        </header>
        <p className="hint">The link may have expired. Ask the host for a new one.</p>
      </main>
    )
  }

  if (!name) {
    return (
      <main className="page page--gate">
        <div className="ticket">
          <p className="eyebrow">Your ticket to</p>
          <h1 className="ticket-title">{info?.media?.title ?? 'the show'}</h1>
          <div className="ticket-rule" aria-hidden="true" />
          <form
            className="name-form"
            onSubmit={e => {
              e.preventDefault()
              const trimmed = nameInput.trim()
              if (!trimmed) return
              localStorage.setItem(NAME_KEY, trimmed)
              setName(trimmed)
            }}
          >
            <input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="Your name" aria-label="Your name" autoFocus />
            <button type="submit" className="btn-primary">Join</button>
          </form>
        </div>
      </main>
    )
  }

  if (!info) return <main className="page"><p className="loading">Warming up the projector…</p></main>

  if (errorLog) {
    const retry = async () => {
      setWsError(null)
      await fetch(`/api/rooms/${token}/retry`, { method: 'POST' })
      location.reload()
    }
    return (
      <main className="page">
        <h1>Couldn't prepare the room</h1>
        <pre className="error-log">{errorLog.join('\n')}</pre>
        <button className="btn-primary" onClick={retry}>Retry</button>
        {isHost && <button className="btn-head" onClick={() => setShowPicker(true)}>🎬 Change movie</button>}
        {showPicker && (
          <MediaPicker token={token} currentItemId={info.media?.itemId ?? null}
            by={name} onClose={() => setShowPicker(false)} />
        )}
      </main>
    )
  }

  return (
    <main className="page page--room">
      {tunnelDown && (
        <div className="banner">
          <span className="banner-dot" aria-hidden="true" />
          Tunnel down, relaunching…
        </div>
      )}
      <div className="room-head">
        <div className="room-head-titles">
          <h1>{info.media ? info.media.title : 'Room without a movie'}</h1>
        </div>
        <div className="room-head-actions">
          {shareUrl && (
            <button type="button" className="btn-head" onClick={() => void copyLink()}
              title={`Copy the room's public link (${shareUrl})`}>
              {copied === 'ok' ? <CheckIcon /> : <LinkIcon />} {copied === 'ok' ? 'Copied!' : 'Copy link'}
            </button>
          )}
          {info.media?.meta && (
            <button type="button" className="btn-head" onClick={() => setShowMeta(true)} title="Movie info">
              <InfoIcon /> Info
            </button>
          )}
          {isHost && (
            <button type="button" className="btn-head" onClick={() => setShowPicker(true)}
              title={info.media ? "Change the room's movie" : "Pick the room's movie"}>
              🎬 {info.media ? 'Change movie' : 'Pick movie'}
            </button>
          )}
        </div>
      </div>
      {copied === 'fail' && shareUrl && (
        <p className="share-fallback">
          <span>Couldn't copy automatically. Copy it by hand:</span>
          <input readOnly autoFocus value={shareUrl} aria-label="Room public link"
            onFocus={e => e.currentTarget.select()} />
        </p>
      )}
      {showMeta && info.media?.meta && <MetaModal meta={info.media.meta} onClose={() => setShowMeta(false)} />}
      {showPicker && (
        <MediaPicker token={token} currentItemId={info.media?.itemId ?? null}
          by={name} onClose={() => setShowPicker(false)} />
      )}
      <div ref={gridRef} className={`room-grid${fullscreen ? ' room-grid--fs' : ''}${cinema ? ' room-grid--cinema' : ''}${fullscreen && !chromeAwake ? ' is-idle' : ''}`}>
        <div className="video-stage">
          {info.media ? (
            <>
              <Player key={info.media.epoch} token={token} media={info.media} streamBase={info.streamBase}
                send={m => sendRef.current(m)} lastState={lastState} welcomeCount={welcomeCount}
                fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />
              <ReactionOverlay reactions={chat.reactions} onDrop={id => dispatchChat({ t: 'drop-reaction', id })} />
              <ReactionsBar send={m => sendRef.current(m)} />
            </>
          ) : (
            // The chat stays mounted on the right: people come in, enter their
            // name and chat while the host chooses.
            <div className="stage-waiting">
              <p className="eyebrow">No movie yet</p>
              <h2>{isHost ? "Pick what you'll watch" : 'The host is picking the movie'}</h2>
              <p className="hint">{isHost
                ? 'Meanwhile you can copy the link and pass it around: the room already exists.'
                : 'You can start chatting; the video will show up on its own.'}</p>
            </div>
          )}
        </div>
        <ChatPanel token={token} state={chat} send={m => sendRef.current(m)}
          onFlashEnd={(pid, id) => dispatchChat({ t: 'drop-flash', pid, id })} />
      </div>
    </main>
  )
}
