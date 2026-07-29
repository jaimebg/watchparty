import { useEffect, useRef, useState } from 'react'
import { getRoom, getStatus } from '../api'
import { connectRoom } from '../ws'
import { Player, type LastState } from '../player/Player'
import type { ClientMsg, RoomInfo } from '../types'

const NAME_KEY = 'jbg-name'
const STATUS_POLL_MS = 30_000

export function Room({ token }: { token: string }) {
  const [name, setName] = useState<string | null>(() => localStorage.getItem(NAME_KEY))
  const [nameInput, setNameInput] = useState('')
  const [info, setInfo] = useState<RoomInfo | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [lastState, setLastState] = useState<LastState | null>(null)
  const [tunnelDown, setTunnelDown] = useState(false)
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
      if (m.t === 'welcome' || m.t === 'state') {
        setLastState({ state: m.state, serverNow: m.serverNow, receivedAt: Date.now() })
      }
      // chat/presence/reaction/buffering de otros llegan en Task 18.
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

  if (info.error) {
    const retry = async () => {
      await fetch(`/api/rooms/${token}/retry`, { method: 'POST' })
      location.reload()
    }
    return (
      <main className="page">
        <h1>Error al preparar la sala</h1>
        <pre className="error-log">{info.error.join('\n')}</pre>
        <button onClick={retry}>Reintentar</button>
      </main>
    )
  }

  return (
    <main className="page">
      {tunnelDown && <div className="banner">Túnel caído, relanzando…</div>}
      <h1>{info.title}</h1>
      <Player token={token} info={info} send={m => sendRef.current(m)} lastState={lastState} />
      {/* Chat llega en Task 18 */}
    </main>
  )
}
