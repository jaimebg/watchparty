import { useEffect, useReducer, useRef, useState } from 'react'
import { getRoom, getStatus } from '../api'
import { connectRoom } from '../ws'
import { Player, type LastState } from '../player/Player'
import { ChatPanel } from '../chat/ChatPanel'
import { ReactionsBar } from '../chat/ReactionsBar'
import { ReactionOverlay } from '../chat/ReactionOverlay'
import { chatReducer, dropReaction, initialChat, type ChatState } from '../chat/chatStore'
import { MetaModal } from '../MetaModal'
import type { ClientMsg, RoomInfo, ServerMsg } from '../types'

const NAME_KEY = 'jbg-name'
const THEATER_KEY = 'jbg-theater'
const STATUS_POLL_MS = 30_000

const InfoIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
  </svg>
)
const TheaterEnterIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
    <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
  </svg>
)
const TheaterExitIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
    <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
  </svg>
)

// Superset of ServerMsg with a UI-only action to retire a reaction once its
// float-up animation finishes. Keeps chatReducer's exported signature (tested
// directly in chatStore.test.ts) limited to ServerMsg, as the brief requires.
type RoomChatAction = ServerMsg | { t: 'drop-reaction'; id: number }

function roomChatReducer(s: ChatState, a: RoomChatAction): ChatState {
  return a.t === 'drop-reaction' ? dropReaction(s, a.id) : chatReducer(s, a)
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
  const [wsError, setWsError] = useState<string[] | null>(null)
  const [chat, dispatchChat] = useReducer(roomChatReducer, initialChat)
  const [theater, setTheater] = useState(() => localStorage.getItem(THEATER_KEY) === '1')
  const [showMeta, setShowMeta] = useState(false)
  const sendRef = useRef<(m: ClientMsg) => void>(() => {})

  const toggleTheater = () => {
    const next = !theater
    setTheater(next)
    localStorage.setItem(THEATER_KEY, next ? '1' : '0')
  }

  useEffect(() => {
    let cancelled = false
    getRoom(token)
      .then(r => { if (!cancelled) setInfo(r) })
      .catch(() => { if (!cancelled) setNotFound(true) })
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    if (!name || notFound) return
    const conn = connectRoom(token, name, m => {
      dispatchChat(m)
      if (m.t === 'welcome' || m.t === 'state') {
        setLastState({ state: m.state, serverNow: m.serverNow, receivedAt: Date.now() })
      }
      if (m.t === 'welcome') setWelcomeCount(c => c + 1)
      if (m.t === 'error') setWsError(m.log)
    })
    sendRef.current = conn.send
    return () => conn.close()
  }, [token, name, notFound])

  // Presencia: avisa cuando la pestaña pasa a segundo plano o vuelve (Page
  // Visibility API; ver spec 2026-07-29-presence-visibility-design.md).
  useEffect(() => {
    const onVis = () => sendRef.current({ t: 'visibility', active: document.visibilityState === 'visible' })
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // Banner de túnel caído: solo el host recibe respuesta de /api/status
  // (a los invitados les da 401, así que se omite silenciosamente).
  useEffect(() => {
    let cancelled = false
    let isHost = true
    const poll = () => {
      if (!isHost || cancelled) return
      getStatus()
        .then(s => { if (!cancelled) setTunnelDown(s.tunnelUrl === null) })
        .catch(() => { isHost = false })
    }
    poll()
    const id = setInterval(poll, STATUS_POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (notFound) {
    return (
      <main className="page page--gate">
        <header className="masthead">
          <p className="eyebrow">JBG Watchparty</p>
          <h1>Sala no encontrada</h1>
          <div className="marquee-rule" aria-hidden="true" />
        </header>
        <p className="hint">El enlace puede haber caducado. Pide al host uno nuevo.</p>
      </main>
    )
  }

  if (!name) {
    return (
      <main className="page page--gate">
        <div className="ticket">
          <p className="eyebrow">Tu entrada para</p>
          <h1 className="ticket-title">{info?.title ?? 'la función'}</h1>
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
            <input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="Tu nombre" aria-label="Tu nombre" autoFocus />
            <button type="submit" className="btn-primary">Entrar</button>
          </form>
        </div>
      </main>
    )
  }

  if (!info) return <main className="page"><p className="loading">Encendiendo el proyector…</p></main>

  // A ffmpeg failure can happen either before the client ever connects
  // (info.error, from the initial REST fetch) or mid-session, reported over
  // the socket as {t:'error'}; both render the same recovery screen.
  const errorLog = wsError ?? info.error
  if (errorLog) {
    const retry = async () => {
      setWsError(null)
      await fetch(`/api/rooms/${token}/retry`, { method: 'POST' })
      location.reload()
    }
    return (
      <main className="page">
        <h1>Error al preparar la sala</h1>
        <pre className="error-log">{errorLog.join('\n')}</pre>
        <button className="btn-primary" onClick={retry}>Reintentar</button>
      </main>
    )
  }

  return (
    <main className={`page page--room${theater ? ' theater' : ''}`}>
      {tunnelDown && (
        <div className="banner">
          <span className="banner-dot" aria-hidden="true" />
          Túnel caído, relanzando…
        </div>
      )}
      <div className="room-head">
        <div className="room-head-titles">
          <p className="eyebrow">En proyección</p>
          <h1>{info.title}</h1>
        </div>
        <div className="room-head-actions">
          {info.meta && (
            <button type="button" className="btn-theater" onClick={() => setShowMeta(true)} title="Información de la película">
              <InfoIcon /> Info
            </button>
          )}
          <button type="button" className="btn-theater" onClick={toggleTheater} title={theater ? 'Salir del modo teatro' : 'Modo teatro'}>
            {theater ? <TheaterExitIcon /> : <TheaterEnterIcon />} {theater ? 'Salir del teatro' : 'Modo teatro'}
          </button>
        </div>
      </div>
      {showMeta && info.meta && <MetaModal meta={info.meta} onClose={() => setShowMeta(false)} />}
      <div className={`room-grid${theater ? ' room-grid--theater' : ''}`}>
        <div className="video-stage">
          <Player token={token} info={info} send={m => sendRef.current(m)} lastState={lastState} welcomeCount={welcomeCount} />
          <ReactionOverlay reactions={chat.reactions} onDrop={id => dispatchChat({ t: 'drop-reaction', id })} />
          <ReactionsBar send={m => sendRef.current(m)} />
        </div>
        <ChatPanel token={token} state={chat} send={m => sendRef.current(m)} />
      </div>
    </main>
  )
}
