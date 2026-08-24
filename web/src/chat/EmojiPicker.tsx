import { useEffect, useState } from 'react'
import { EMOJI_GROUPS, searchEmojis, type EmojiRow } from './emojiSearch'
import { MAX_QUICK } from './quickEmojis'

export function EmojiPicker({
  quick, onAdd, onRemove, onClose,
}: {
  quick: string[]
  onAdd: (emoji: string) => void
  onRemove: (emoji: string) => void
  onClose: () => void
}) {
  const [catalog, setCatalog] = useState<EmojiRow[] | null>(null)
  const [group, setGroup] = useState(EMOJI_GROUPS[0].group)
  const [query, setQuery] = useState('')

  // El catálogo son ~105 KB: se carga la primera vez que se abre el modal, no
  // al entrar en la sala. Vite lo separa en su propio chunk.
  useEffect(() => {
    let cancelled = false
    import('./emojiCatalog')
      .then(m => { if (!cancelled) setCatalog(m.EMOJI_CATALOG) })
      .catch(() => { if (!cancelled) setCatalog([]) })
    return () => { cancelled = true }
  }, [])

  const searching = query.trim() !== ''
  const full = quick.length >= MAX_QUICK
  const shown = catalog === null ? []
    : searching ? searchEmojis(catalog, query)
    : catalog.filter(r => r[3] === group)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* Sin cierre con Escape: en pantalla completa el navegador se queda esa
          tecla para salir del modo y no se puede evitar, así que sería un atajo
          que funciona a medias. Se cierra con el fondo y con la ✕. */}
      <div className="modal emoji-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" aria-label="Cerrar" onClick={onClose}>✕</button>

        <h2 className="emoji-heading">Your quick picks</h2>
        {quick.length === 0
          ? <p className="hint">None yet: pick the ones you want below.</p>
          : <ul className="quick-chips">
              {quick.map(e => (
                <li key={e}>
                  <span aria-hidden>{e}</span>
                  <button type="button" aria-label={`Remove `} onClick={() => onRemove(e)}>✕</button>
                </li>
              ))}
            </ul>}
        {full && <p className="hint">Max {MAX_QUICK}: remove one to add another.</p>}

        <input className="emoji-search" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Search emoji…" aria-label="Search emoji" />

        {!searching && (
          <div className="emoji-tabs" role="tablist">
            {EMOJI_GROUPS.map(g => (
              <button key={g.group} type="button" role="tab" aria-selected={g.group === group}
                aria-label={g.label} title={g.label}
                className={g.group === group ? 'is-active' : undefined}
                onClick={() => setGroup(g.group)}>{g.icon}</button>
            ))}
          </div>
        )}

        {catalog === null ? (
          <p className="gif-picker-status">Loading emojis…</p>
        ) : searching && shown.length === 0 ? (
          <p className="gif-picker-status">No emoji matches.</p>
        ) : (
          <div className="emoji-grid">
            {shown.map(r => (
              <button key={r[0]} type="button" aria-label={r[1]} title={r[1]}
                disabled={full || quick.includes(r[0])}
                onClick={() => onAdd(r[0])}>{r[0]}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
