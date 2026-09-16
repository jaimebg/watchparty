import { useEffect, useState } from 'react'
import { lang, t } from '../i18n'
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

  // The catalog is ~105 KB: it loads the first time the modal opens, not on
  // entering the room. Vite splits it into its own chunk.
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
    : catalog.filter(r => r[4] === group)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* No Escape-to-close: in fullscreen the browser keeps that key to leave
          the mode and there is no preventing it, so it would be a shortcut that
          half works. It closes with the backdrop and with the ✕. */}
      <div className="modal emoji-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" aria-label={t('common.close')} onClick={onClose}>✕</button>

        <h2 className="emoji-heading">{t('emoji.quickPicks')}</h2>
        {quick.length === 0
          ? <p className="hint">{t('emoji.noneYet')}</p>
          : <ul className="quick-chips">
              {quick.map(e => (
                <li key={e}>
                  <span aria-hidden>{e}</span>
                  <button type="button" aria-label={t('emoji.remove', { emoji: e })} onClick={() => onRemove(e)}>✕</button>
                </li>
              ))}
            </ul>}
        {full && <p className="hint">{t('emoji.max', { max: MAX_QUICK })}</p>}

        <input className="emoji-search" value={query} onChange={e => setQuery(e.target.value)}
          placeholder={t('emoji.searchPlaceholder')} aria-label={t('emoji.searchLabel')} />

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
          <p className="gif-picker-status">{t('emoji.loading')}</p>
        ) : searching && shown.length === 0 ? (
          <p className="gif-picker-status">{t('emoji.noMatch')}</p>
        ) : (
          <div className="emoji-grid">
            {shown.map(r => (
              <button key={r[0]} type="button" aria-label={lang === 'es' ? r[2] : r[1]} title={lang === 'es' ? r[2] : r[1]}
                disabled={full || quick.includes(r[0])}
                onClick={() => onAdd(r[0])}>{r[0]}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
