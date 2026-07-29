import { useEffect, useReducer, useRef, useState } from 'react'
import { getRoom, getStatus } from '../api'
import { connectRoom } from '../ws'
import { Player, type LastState } from '../player/Player'
import { ChatPanel } from '../chat/ChatPanel'
import { ReactionsBar } from '../chat/ReactionsBar'
import { ReactionOverlay } from '../chat/ReactionOverlay'
import { chatReducer, dropReaction, initialChat, type ChatState } from '../chat/chatStore'
import type { ClientMsg, RoomInfo, ServerMsg } from '../types'

const NAME_KEY = 'jbg-name'
const STATUS_POLL_MS = 30_000

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
  const [tunnelDown, setTunnelDown] = useState(false)
  const [wsError, setWsError] = useState<string[] | null>(null)
  const [chat, dispatchChat] = useReducer(roomChatReducer, initialChat)
  const sendRef = useRef<(m: ClientMsg) => void>(() => {})

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
      if (m.t === 'error') setWsError(m.log)
    })
    sendRef.current = conn.send
    return () => conn.close()
  }, [token, name, notFound])

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

  if (notFound) return <main className="page"><h1>Sala no encontrada</h1></main>

  if (!name) {
    return (
      <main className="page">
        <h1>Sala {token}</h1>
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
          <input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="Tu nombre" autoFocus />
          <button type="submit">Entrar</button>
        </form>
      </main>
    )
  }

  if (!info) return <main className="page"><p>Cargando…</p></main>

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
        <button onClick={retry}>Reintentar</button>
      </main>
    )
  }

  return (
    <main className="page page--room">
      {tunnelDown && <div className="banner">Túnel caído, relanzando…</div>}
      <h1>{info.title}</h1>
      <div className="room-grid">
        <div className="video-stage">
          <Player token={token} info={info} send={m => sendRef.current(m)} lastState={lastState} />
          <ReactionOverlay reactions={chat.reactions} onDrop={id => dispatchChat({ t: 'drop-reaction', id })} />
          <ReactionsBar send={m => sendRef.current(m)} />
        </div>
        <ChatPanel token={token} state={chat} send={m => sendRef.current(m)} />
      </div>
    </main>
  )
}
