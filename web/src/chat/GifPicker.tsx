import { useEffect, useState } from 'react'
import { searchGifs } from '../api'
import type { GifResult } from '../types'

const DEBOUNCE_MS = 300

export function GifPicker({
  token, onPick, onClose, onDisabled,
}: {
  token: string
  onPick: (url: string) => void
  onClose: () => void
  onDisabled: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GifResult[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const id = setTimeout(() => {
      searchGifs(query, token)
        .then(r => {
          if (cancelled) return
          if ('gifsDisabled' in r) { onDisabled(); return }
          setResults(r.results)
        })
        .catch(() => { if (!cancelled) setResults([]) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, DEBOUNCE_MS)
    return () => { cancelled = true; clearTimeout(id) }
  }, [query, token])

  return (
    <div className="gif-picker">
      <div className="gif-picker-header">
        <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar GIFs…" />
        <button type="button" onClick={onClose}>✕</button>
      </div>
      {loading && <p className="gif-picker-status">Buscando…</p>}
      <div className="gif-grid">
        {results.map(g => (
          <img key={g.id} src={g.previewUrl} alt={g.title} onClick={() => onPick(g.url)} />
        ))}
      </div>
    </div>
  )
}
