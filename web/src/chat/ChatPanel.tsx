import { useEffect, useRef, useState } from 'react'
import { searchGifs } from '../api'
import { GifPicker } from './GifPicker'
import type { ChatState } from './chatStore'
import type { ClientMsg } from '../types'

export function ChatPanel({
  token, state, send, onFlashEnd,
}: {
  token: string
  state: ChatState
  send: (m: ClientMsg) => void
  onFlashEnd: (pid: string, id: number) => void
}) {
  const [text, setText] = useState('')
  const [gifOpen, setGifOpen] = useState(false)
  const [gifsDisabled, setGifsDisabled] = useState(false)
  const entriesRef = useRef<HTMLDivElement>(null)
  const entriesInnerRef = useRef<HTMLDivElement>(null)

  // Probe once whether GIFs are configured server-side, so the button never
  // flashes on for a deployment without a Klipy API key.
  useEffect(() => {
    let cancelled = false
    searchGifs('', token)
      .then(r => { if (!cancelled && 'gifsDisabled' in r) setGifsDisabled(true) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  // Por altura y no por entrada nueva: cuando llega el mensaje, la <img> de un
  // GIF aún mide 0 px y scrollHeight es el de antes, así que la lista se queda
  // arriba en cuanto la imagen carga. Observar el contenido cubre de una vez el
  // GIF tardío, el mensaje multilínea y el cambio de tamaño del panel.
  useEffect(() => {
    const box = entriesRef.current
    const inner = entriesInnerRef.current
    if (!box || !inner) return
    const toBottom = () => { box.scrollTop = box.scrollHeight }
    const ro = new ResizeObserver(toBottom)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    send({ t: 'chat', text: trimmed })
    setText('')
  }

  return (
    <aside className="chat-panel">
      <ul className="participants">
        {state.participants.map(p => {
          const flash = state.flashes[p.id]
          return (
            <li key={p.id} className={p.active ? undefined : 'away'} title={p.active ? undefined : 'ausente'}>
              <span className="dot" style={{ background: p.color }} />
              {p.name}
              {/* La key es el id del destello, no el del participante: así una
                  reacción nueva remonta el span y la animación arranca de cero
                  en vez de quedarse a medias. */}
              {flash && (
                <span key={flash.id} className="reaction-flash" aria-hidden
                  onAnimationEnd={() => onFlashEnd(p.id, flash.id)}>
                  {flash.emoji}
                </span>
              )}
            </li>
          )
        })}
      </ul>

      <div className="chat-entries" ref={entriesRef}>
        <div className="chat-entries-inner" ref={entriesInnerRef}>
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
