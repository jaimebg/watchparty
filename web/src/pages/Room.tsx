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
  // Solo el host: /api/status responde 401 a los invitados. Es la misma señal
  // que ya se usaba para el enlace del túnel, ahora con nombre propio, porque
  // gobierna también el botón de elegir película.
  const [isHost, setIsHost] = useState(false)
  // Solo el host la conoce: /api/status responde 401 a los invitados. Por eso
  // el botón de copiar aparece únicamente en la pestaña del host (localhost),
  // que es justo la que necesita el enlace del túnel en vez de su propia URL.
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle')
  const [wsError, setWsError] = useState<string[] | null>(null)
  const [chat, dispatchChat] = useReducer(roomChatReducer, initialChat)
  const [showMeta, setShowMeta] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const sendRef = useRef<(m: ClientMsg) => void>(() => {})
  const gridRef = useRef<HTMLDivElement>(null)
  const { active: fullscreen, cinema, toggle: toggleFullscreen, exit: exitFullscreen } = useFullscreen(gridRef)

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

  // El reintento se llama a sí mismo, y `reloadInfo` no puede depender de su
  // propia identidad: cambiarla reengancharía el efecto del socket (reconectar
  // tira chat y presencia). El ref rompe ese ciclo.
  const reloadRef = useRef<() => Promise<void>>(async () => {})
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryAttemptRef = useRef(0)

  // `getRoom` lanza igual con un 404 que con un 502 del túnel o un corte de red,
  // y esto ya no corre solo al montar: corre en mitad de la sesión con cada
  // cambio de película. Solo el 404 significa «esta sala ya no existe»; dar la
  // sala por perdida ante un error pasajero pintaría «Sala no encontrada» y, de
  // paso, cerraría el socket por la guarda del efecto de abajo, dejando al
  // invitado sin chat, sin presencia y sin nada que reintentar. Lo transitorio
  // no toca el `info` que ya se esté enseñando y se reintenta solo, con el mismo
  // backoff que usa la reconexión del socket.
  const reloadInfo = useCallback(async () => {
    try {
      setInfo(await getRoom(token))
      if (retryRef.current !== null) { clearTimeout(retryRef.current); retryRef.current = null }
      retryAttemptRef.current = 0
    } catch (e) {
      if (e instanceof Error && e.message.includes('404')) { setNotFound(true); return }
      // Un solo reintento en vuelo: varios {t:'media'} seguidos con la red caída
      // no deben encadenar temporizadores.
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

  // Espejo de `info` para el callback del socket: si entrara en las
  // dependencias del efecto, cada refresco reconectaría el socket.
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
        // {t:'media'} solo lo recibe quien tuviera el socket abierto en el
        // instante del cambio: el invitado que seguía en la puerta del nombre no
        // lo ve nunca, y el que estaba reconectando tampoco. Sin esto se quedan
        // con la generación anterior para siempre: cartel de «el host está
        // eligiendo» en una sala que ya tiene película, o un reproductor pidiendo
        // URLs que ahora responden 410, en negro y sin ruido. El `welcome` trae
        // la generación viva, así que se compara y se refresca si no casan.
        // Con `info` aún sin llegar no se compara: la petición REST del montaje
        // va en vuelo (o reintentándose) y traerá esa misma generación, y pedirla
        // aquí sería una petición de más en cada arranque normal.
        const known = infoRef.current
        if (known && m.epoch !== (known.media?.epoch ?? null)) {
          // Mismo tratamiento que el {t:'media'} que este cliente se perdió,
          // incluido el `wsError`: el fallo de ffmpeg que pudiera arrastrar era
          // de la generación anterior.
          setWsError(null)
          void reloadInfo()
        }
      }
      if (m.t === 'error') setWsError(m.log)
      if (m.t === 'media') {
        // Un solo camino de refresco, también para el host que lo provocó: el
        // POST no actualiza estado por su cuenta, así que no hay dos rutas que
        // puedan divergir. El `wsError` se limpia porque el fallo de ffmpeg era
        // de la película anterior.
        setWsError(null)
        void reloadInfo()
      }
    })
    sendRef.current = conn.send
    return () => conn.close()
  }, [token, name, notFound, reloadInfo])

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
          setIsHost(true)
          setTunnelUrl(s.tunnelUrl)
          setTunnelDown(s.tunnelUrl === null)
        })
        // 401: es un invitado. Se deja de sondear, no se le enseña el enlace del
        // túnel y no verá el botón de elegir película.
        .catch(() => { polling = false; setIsHost(false) })
    }
    poll()
    const id = setInterval(poll, STATUS_POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // A ffmpeg failure can happen either before the client ever connects
  // (info.error, from the initial REST fetch) or mid-session, reported over
  // the socket as {t:'error'}; both render the same recovery screen. Se
  // calcula aquí arriba —antes de los "return" tempranos— porque las Reglas
  // de los Hooks exigen que useEffect se llame siempre en el mismo orden;
  // `info` aún puede ser `null` en este punto.
  const errorLog = wsError ?? info?.error

  // El modo cine no se autolimpia como la pantalla completa nativa (que sí
  // sale sola en cuanto el nodo desaparece del árbol): es un `position:
  // fixed` sostenido por estado de React, y Room no se desmonta al entrar en
  // el estado de error, solo cambia el JSX que devuelve. Sin esto, cinema se
  // queda en `true` y el body sigue con scroll bloqueado sobre la pantalla de
  // error, con el botón «Reintentar» posiblemente inalcanzable y sin más
  // salida que el Escape que el iPhone —el único sitio con modo cine— no
  // tiene.
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
            // El chat sigue montado a la derecha: la gente entra, pone su nombre
            // y charla mientras el host elige.
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
