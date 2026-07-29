import { useEffect, useRef, useState } from 'react'
import { searchGifs } from '../api'
import { GifPicker } from './GifPicker'
import type { ChatState } from './chatStore'
import type { ClientMsg } from '../types'

export function ChatPanel({
  token, state, send,
}: {
  token: string
  state: ChatState
  send: (m: ClientMsg) => void
}) {
  const [text, setText] = useState('')
  const [gifOpen, setGifOpen] = useState(false)
  const [gifsDisabled, setGifsDisabled] = useState(false)
  const entriesRef = useRef<HTMLDivElement>(null)

  // Probe once whether GIFs are configured server-side, so the button never
  // flashes on for a deployment without a Klipy API key.
  useEffect(() => {
    let cancelled = false
    searchGifs('', token)
      .then(r => { if (!cancelled && 'gifsDisabled' in r) setGifsDisabled(true) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    const el = entriesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.entries])

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    send({ t: 'chat', text: trimmed })
    setText('')
  }

  return (
    <aside className="chat-panel">
      <ul className="participants">
        {state.participants.map(p => (
          <li key={p.id}>
            <span className="dot" style={{ background: p.color }} />
            {p.name}
          </li>
        ))}
      </ul>

      <div className="chat-entries" ref={entriesRef}>
        {state.entries.map(e => (
          <div key={e.id} className={`chat-entry chat-entry--${e.kind}`}>
            {e.kind === 'system' ? (
              <em>{e.text}</em>
            ) : e.kind === 'gif' ? (
              <>
                <span style={{ color: e.from.color }}>{e.from.name}</span>
                <img src={e.gifUrl ?? ''} alt="gif" />
              </>
            ) : (
              <>
                <span style={{ color: e.from.color }}>{e.from.name}: </span>
                {e.text}
              </>
            )}
          </div>
        ))}
      </div>

      {state.buffering.map(n => (
        <p key={n} className="buffering-note">{n} está cargando…</p>
      ))}

      <form className="chat-input" onSubmit={e => { e.preventDefault(); submit() }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Escribe un mensaje…" aria-label="Mensaje de chat" />
        {!gifsDisabled && (
          <button type="button" onClick={() => setGifOpen(v => !v)}>GIF</button>
        )}
        <button type="submit" className="btn-primary">Enviar</button>
      </form>

      {gifOpen && !gifsDisabled && (
        <GifPicker
          token={token}
          onDisabled={() => { setGifsDisabled(true); setGifOpen(false) }}
          onPick={url => { send({ t: 'gif', url }); setGifOpen(false) }}
          onClose={() => setGifOpen(false)}
        />
      )}
    </aside>
  )
}
