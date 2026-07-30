import { useEffect, useMemo, useRef, useState } from 'react'
import { getLibrary, rescanLibrary, setRoomMedia } from './api'
// Se reutilizan del buscador de emojis en vez de duplicarlos: `normalize` ya
// hace el NFD sin diacríticos que hace falta para que «corazon» encuentre
// «Corazón», y `SEARCH_LIMIT` ya es el tope de 120 resultados que evita meter
// cientos de botones en el DOM.
import { normalize, SEARCH_LIMIT } from './chat/emojiSearch'
import type { LibraryItem } from './types'

interface Folder { path: string; name: string; items: LibraryItem[] }

export function groupByFolder(items: LibraryItem[]): Folder[] {
  const byPath = new Map<string, Folder>()
  for (const i of items) {
    // Por folderPath y no por folderName: dos series pueden tener una «Season 1»
    // cada una, y agrupar por nombre las fusiona con los episodios mezclados.
    const f = byPath.get(i.folderPath) ?? { path: i.folderPath, name: i.folderName, items: [] }
    f.items.push(i)
    byPath.set(i.folderPath, f)
  }
  return [...byPath.values()]
}

// `currentItemId` y no el título: el que enseña la sala sale de displayTitle
// («La Gran Peli (2020)») y el de la biblioteca de cleanName del nombre de
// fichero («La Gran Peli»), así que con TMDB resolviendo —el caso normal— nunca
// son iguales. Comparar por texto pintado ata este modal a cómo se compone un
// título en el servidor y se rompe cada vez que alguien lo toca; el id es un
// identificador estable que ya viaja en la respuesta de la sala.
export function MediaPicker({ token, currentItemId, by, onClose }: {
  token: string
  currentItemId: string | null
  by: string
  onClose: () => void
}) {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Confirmación en dos pasos DENTRO del modal, no `window.confirm`: un diálogo
  // nativo puede sacar al host de pantalla completa, y el proyecto ya resuelve
  // esto con modales propios en vez de nativos (ver EmojiPicker).
  const [pending, setPending] = useState<LibraryItem | null>(null)
  // Sigue montado: `apply` y `rescan` lanzan peticiones que pueden tardar, y el
  // host puede cerrar el modal (✕ o clic en el fondo) sin esperar a que
  // acaben. Sin esta bandera sus callbacks harían setState sobre un
  // componente ya desmontado.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  useEffect(() => {
    let cancelled = false
    getLibrary()
      .then(l => { if (!cancelled) setItems(l) })
      .catch(e => { if (!cancelled) { setItems([]); setError(e instanceof Error ? e.message : String(e)) } })
    return () => { cancelled = true }
  }, [])

  const folders = useMemo(() => groupByFolder(items ?? []), [items])

  // Ya se hizo el auto-open inicial: sin esta bandera, cerrar a mano la
  // carpeta abierta (el toggle pone `open` a null) volvería a disparar este
  // efecto y la reabriría de inmediato, dejando esa carpeta imposible de
  // colapsar. `open` se deja fuera de las dependencias a propósito: el efecto
  // solo debe correr una vez, cuando llega la biblioteca.
  const autoOpenedRef = useRef(false)

  // Arranca abierta la carpeta de la película puesta; si no hay, la primera.
  useEffect(() => {
    if (autoOpenedRef.current || folders.length === 0) return
    autoOpenedRef.current = true
    const current = currentItemId ? folders.find(f => f.items.some(i => i.id === currentItemId)) : null
    setOpen((current ?? folders[0]).path)
  }, [folders, currentItemId])

  const searching = query.trim() !== ''
  const results = useMemo(() => {
    if (!searching) return []
    const q = normalize(query.trim())
    return (items ?? []).filter(i => normalize(i.title).includes(q)).slice(0, SEARCH_LIMIT)
  }, [items, query, searching])

  const apply = async (item: LibraryItem) => {
    setBusy(true)
    setError(null)
    try {
      await setRoomMedia(token, item.id, by)
      // La sala se refresca sola con el {t:'media'} que llega por el socket.
      // Se llama siempre, montado o no: es el padre quien decide cerrar, y
      // seguirá estándolo aunque este componente ya no lo esté.
      onClose()
    } catch (e) {
      if (!mountedRef.current) return
      // Se muestra dentro del modal sin cerrarlo, para poder elegir otra cosa.
      setError(e instanceof Error ? e.message : String(e))
      setPending(null)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  // Cambiar interrumpe a todo el mundo, así que se confirma. Poner la primera
  // película en una sala vacía no interrumpe nada: va directa.
  const pick = (item: LibraryItem) => { if (currentItemId) setPending(item); else void apply(item) }

  const rescan = () => {
    setBusy(true)
    setError(null)
    rescanLibrary()
      .then(l => { if (mountedRef.current) setItems(l) })
      .catch(e => { if (mountedRef.current) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (mountedRef.current) setBusy(false) })
  }

  const row = (i: LibraryItem, withFolder: boolean) => (
    <li key={i.id}>
      <button type="button" className="media-btn" disabled={busy} onClick={() => pick(i)}>
        <span className="media-title">
          {i.title}
          {i.id === currentItemId && <span className="media-current"> · en emisión</span>}
        </span>
        <span className="hint">
          {withFolder && <>{i.folderName} · </>}
          {i.srtFiles.length > 0
            ? `${i.srtFiles.length} ${i.srtFiles.length === 1 ? 'subtítulo externo' : 'subtítulos externos'}`
            : 'sin subtítulos externos'}
        </span>
      </button>
    </li>
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* Sin cierre con Escape: en pantalla completa el navegador se queda esa
          tecla para salir del modo y no se puede evitar, así que sería un atajo
          que funciona a medias. Se cierra con el fondo y con la ✕. */}
      <div className="modal media-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" aria-label="Cerrar" onClick={onClose}>✕</button>
        <h2>{currentItemId ? 'Cambiar película' : 'Elegir película'}</h2>

        <input className="emoji-search" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Buscar por título…" aria-label="Buscar película" />

        {error && <p className="field-error">{error}</p>}

        {pending && (
          <div className="media-confirm">
            <p>Vas a cambiar la película <strong>para todos</strong>. La reproducción
              empieza de cero y el chat se conserva.</p>
            <p className="media-title">«{pending.title}»</p>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void apply(pending)}>
              {busy ? 'Poniendo…' : 'Ponerla'}
            </button>
            <button type="button" className="btn-small" disabled={busy} onClick={() => setPending(null)}>
              Cancelar
            </button>
          </div>
        )}

        {items === null ? (
          <p className="gif-picker-status">Cargando la biblioteca…</p>
        ) : items.length === 0 ? (
          <p className="gif-picker-status">No hay vídeos en las carpetas configuradas.</p>
        ) : searching ? (
          results.length === 0
            ? <p className="gif-picker-status">Ningún título coincide.</p>
            : <ul className="media-list">{results.map(i => row(i, true))}</ul>
        ) : (
          <div className="media-folders">
            {folders.map(f => (
              <section key={f.path}>
                <button type="button" className="media-folder" aria-expanded={open === f.path}
                  onClick={() => setOpen(open === f.path ? null : f.path)}>
                  <span>{open === f.path ? '▾' : '▸'} {f.name}</span>
                  <span className="hint">{f.items.length}</span>
                </button>
                {/* Solo la carpeta abierta se renderiza: con cientos de medios,
                    pintarlas todas mete miles de botones en el DOM. */}
                {open === f.path && (
                  <>
                    <p className="hint media-folder-path">{f.path}</p>
                    <ul className="media-list">{f.items.map(i => row(i, false))}</ul>
                  </>
                )}
              </section>
            ))}
          </div>
        )}

        <button type="button" className="btn-small" disabled={busy} onClick={rescan}>
          {busy ? 'Trabajando…' : '↻ Volver a escanear'}
        </button>
      </div>
    </div>
  )
}
