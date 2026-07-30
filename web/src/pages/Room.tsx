import { useEffect, useReducer, useRef, useState } from 'react'
import { getRoom, getStatus } from '../api'
import { connectRoom } from '../ws'
import { Player, type LastState } from '../player/Player'
import { useFullscreen } from '../player/useFullscreen'
import { useIdleChrome } from '../player/useIdleChrome'
import { isTypingTarget } from '../player/format'
import { ChatPanel } from '../chat/ChatPanel'
import { ReactionsBar } from '../chat/ReactionsBar'
import { ReactionOverlay } from '../chat/ReactionOverlay'
import { chatReducer, dropFlash, dropReaction, initialChat, type ChatState } from '../chat/chatStore'
import { MetaModal } from '../MetaModal'
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
  // Solo el host la conoce: /api/status responde 401 a los invitados. Por eso
  // el botón de copiar aparece únicamente en la pestaña del host (localhost),
  // que es justo la que necesita el enlace del túnel en vez de su propia URL.
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle')
  const [wsError, setWsError] = useState<string[] | null>(null)
  const [chat, dispatchChat] = useReducer(roomChatReducer, initialChat)
  const [showMeta, setShowMeta] = useState(false)
  const sendRef = useRef<(m: ClientMsg) => void>(() => {})
  const gridRef = useRef<HTMLDivElement>(null)
  const { active: fullscreen, cinema, toggle: toggleFullscreen } = useFullscreen(gridRef)

  // El temporizador consulta esto al vencer: con la sala en pausa o con alguien
  // escribiendo, el chrome no se va.
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

  // Un mensaje nuevo despierta el chrome sin necesidad de tocar el ratón. Los
  // de sistema («X pausó») no cuentan: son ruido, no conversación. La primera
  // pasada se ignora para que el historial que llega en el `welcome` no cuente
  // como mensaje nuevo.
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
      // Sin portapapeles (contexto no seguro, permiso denegado): se enseña el
      // enlace para copiarlo a mano en vez de fallar en silencio.
      setCopied('fail')
    }
  }

  useEffect(() => {
    if (copied !== 'ok') return
    const id = setTimeout(() => setCopied('idle'), COPIED_FEEDBACK_MS)
    return () => clearTimeout(id)
  }, [copied])

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
    let polling = true
    const poll = () => {
      if (!polling || cancelled) return
      getStatus()
        .then(s => {
          if (cancelled) return
          setTunnelUrl(s.tunnelUrl)
          setTunnelDown(s.tunnelUrl === null)
        })
        // 401: es un invitado. Se deja de sondear y no se le enseña el enlace
        // del túnel.
        .catch(() => { polling = false })
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
    <main className="page page--room">
      {tunnelDown && (
        <div className="banner">
          <span className="banner-dot" aria-hidden="true" />
          Túnel caído, relanzando…
        </div>
      )}
      <div className="room-head">
        <div className="room-head-titles">
          <h1>{info.title}</h1>
        </div>
        <div className="room-head-actions">
          {shareUrl && (
            <button type="button" className="btn-head" onClick={() => void copyLink()}
              title={`Copiar el enlace público de la sala (${shareUrl})`}>
              {copied === 'ok' ? <CheckIcon /> : <LinkIcon />} {copied === 'ok' ? '¡Copiado!' : 'Copiar enlace'}
            </button>
          )}
          {info.meta && (
            <button type="button" className="btn-head" onClick={() => setShowMeta(true)} title="Información de la película">
              <InfoIcon /> Info
            </button>
          )}
        </div>
      </div>
      {copied === 'fail' && shareUrl && (
        <p className="share-fallback">
          <span>No se pudo copiar solo. Cópialo a mano:</span>
          <input readOnly autoFocus value={shareUrl} aria-label="Enlace público de la sala"
            onFocus={e => e.currentTarget.select()} />
        </p>
      )}
      {showMeta && info.meta && <MetaModal meta={info.meta} onClose={() => setShowMeta(false)} />}
      <div ref={gridRef} className={`room-grid${fullscreen ? ' room-grid--fs' : ''}${cinema ? ' room-grid--cinema' : ''}${fullscreen && !chromeAwake ? ' is-idle' : ''}`}>
        <div className="video-stage">
          <Player token={token} info={info} send={m => sendRef.current(m)} lastState={lastState} welcomeCount={welcomeCount}
            fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />
          <ReactionOverlay reactions={chat.reactions} onDrop={id => dispatchChat({ t: 'drop-reaction', id })} />
          <ReactionsBar send={m => sendRef.current(m)} />
        </div>
        <ChatPanel token={token} state={chat} send={m => sendRef.current(m)}
          onFlashEnd={(pid, id) => dispatchChat({ t: 'drop-flash', pid, id })} />
      </div>
    </main>
  )
}
