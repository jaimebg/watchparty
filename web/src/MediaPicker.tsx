import { useEffect, useMemo, useRef, useState } from 'react'
import { getLibrary, rescanLibrary, setRoomMedia } from './api'
// Reused from the emoji search rather than duplicated: `normalize` already does
// the diacritic-free NFD that lets "corazon" find "Corazón", and `SEARCH_LIMIT`
// is already the 120-result cap that keeps hundreds of buttons out of the DOM.
import { normalize, SEARCH_LIMIT } from './chat/emojiSearch'
import type { LibraryItem } from './types'

interface Folder { path: string; name: string; items: LibraryItem[] }

export function groupByFolder(items: LibraryItem[]): Folder[] {
  const byPath = new Map<string, Folder>()
  for (const i of items) {
    // By folderPath and not folderName: two series can each have a "Season 1",
    // and grouping by name merges them with the episodes mixed together.
    const f = byPath.get(i.folderPath) ?? { path: i.folderPath, name: i.folderName, items: [] }
    f.items.push(i)
    byPath.set(i.folderPath, f)
  }
  return [...byPath.values()]
}

// `currentItemId` and not the title: the one the room shows comes from
// displayTitle ("The Big Movie (2020)") and the library's from cleanName of the
// file name ("The Big Movie"), so with TMDB resolving — the normal case — they
// are never equal. Comparing rendered text ties this modal to how a title is
// composed on the server and breaks every time someone touches it; the id is a
// stable identifier that already travels in the room's response.
export function MediaPicker({ token, currentItemId, by, onClose }: {
  token: string
  currentItemId: string | null
  by: string
  onClose: () => void
}) {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  // Kept apart because the two waits are told differently: setting a movie
  // covers the modal with the waiting card (that is the long operation: the
  // server probes the video and extracts subtitles), while a rescan only changes
  // its button's label. `busy` remains the shared "don't touch anything".
  const [applying, setApplying] = useState<LibraryItem | null>(null)
  const [rescanning, setRescanning] = useState(false)
  const busy = applying !== null || rescanning
  const [error, setError] = useState<string | null>(null)
  // Two-step confirmation INSIDE the modal, not `window.confirm`: a native
  // dialog can kick the host out of fullscreen, and this project already solves
  // that with its own modals rather than native ones (see EmojiPicker).
  const [pending, setPending] = useState<LibraryItem | null>(null)
  // Still mounted: `apply` and `rescan` fire requests that can take a while, and
  // the host can close the modal (✕ or a click on the backdrop) without waiting
  // for them. Without this flag their callbacks would setState on an already
  // unmounted component.
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

  // The initial auto-open has already happened: without this flag, closing the
  // open folder by hand (the toggle sets `open` to null) would fire this effect
  // again and reopen it immediately, leaving that folder impossible to collapse.
  // `open` is deliberately left out of the dependencies: the effect should run
  // once, when the library arrives.
  const autoOpenedRef = useRef(false)

  // The folder of the movie now playing starts open; failing that, the first.
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
    setApplying(item)
    setError(null)
    try {
      await setRoomMedia(token, item.id, by)
      // The room refreshes itself on the {t:'media'} that arrives over the
      // socket. This is always called, mounted or not: the parent decides to
      // close, and it will still be around even when this component is not.
      onClose()
    } catch (e) {
      if (!mountedRef.current) return
      // Shown inside the modal without closing it, so something else can be picked.
      setError(e instanceof Error ? e.message : String(e))
      setPending(null)
    } finally {
      if (mountedRef.current) setApplying(null)
    }
  }

  // Changing interrupts everyone, so it is confirmed. Setting the first movie in
  // an empty room interrupts nothing: it goes straight through.
  const pick = (item: LibraryItem) => { if (currentItemId) setPending(item); else void apply(item) }

  const rescan = () => {
    setRescanning(true)
    setError(null)
    rescanLibrary()
      .then(l => { if (mountedRef.current) setItems(l) })
      .catch(e => { if (mountedRef.current) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (mountedRef.current) setRescanning(false) })
  }

  const row = (i: LibraryItem, withFolder: boolean) => (
    <li key={i.id}>
      <button type="button" className="media-btn" disabled={busy} onClick={() => pick(i)}>
        <span className="media-title">
          {i.title}
          {i.id === currentItemId && <span className="media-current"> · now playing</span>}
        </span>
        <span className="hint">
          {withFolder && <>{i.folderName} · </>}
          {i.srtFiles.length > 0
            ? `${i.srtFiles.length} external subtitle${i.srtFiles.length === 1 ? '' : 's'}`
            : 'no external subtitles'}
        </span>
      </button>
    </li>
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* No Escape-to-close: in fullscreen the browser keeps that key to leave
          the mode and there is no preventing it, so it would be a shortcut that
          half works. It closes with the backdrop and with the ✕. */}
      <div className="modal media-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" aria-label="Close" onClick={onClose}>✕</button>
        <h2>{currentItemId ? 'Change movie' : 'Pick movie'}</h2>

        {/* While the movie is being set the modal hides the list: the wait runs
            several seconds and leaving the library on screen with everything
            disabled said nothing about anything happening. The ✕ is still there
            so you can leave without waiting (`mountedRef` covers that). */}
        {applying ? (
          <div className="modal-busy" role="status" aria-live="polite">
            <span className="spinner spinner--lg" aria-hidden="true" />
            <p className="media-title">“{applying.title}”</p>
            <p className="hint">Getting it ready for the whole room: we analyze the video and
              extract the subtitles. It can take a few seconds.</p>
          </div>
        ) : (
          <>
            <input className="emoji-search" value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search by title…" aria-label="Search movies" />

            {error && <p className="field-error">{error}</p>}

            {pending && (
              <div className="media-confirm">
                <p>You're about to change the movie <strong>for everyone</strong>. Playback
                  starts over and the chat is kept.</p>
                <p className="media-title">“{pending.title}”</p>
                {/* No "setting…" label: the moment it is pressed, `applying`
                    takes this branch away and the waiting card appears. */}
                <button type="button" className="btn-primary" disabled={busy} onClick={() => void apply(pending)}>
                  Play it
                </button>
                <button type="button" className="btn-small" disabled={busy} onClick={() => setPending(null)}>
                  Cancel
                </button>
              </div>
            )}

            {items === null ? (
              <p className="gif-picker-status"><span className="spinner" aria-hidden="true" /> Loading the library…</p>
            ) : items.length === 0 ? (
              <p className="gif-picker-status">No videos in the configured folders.</p>
            ) : searching ? (
              results.length === 0
                ? <p className="gif-picker-status">No titles match.</p>
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
                    {/* Only the open folder renders: with hundreds of items,
                        painting them all puts thousands of buttons in the DOM. */}
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
              {rescanning
                ? <><span className="spinner" aria-hidden="true" /> Scanning…</>
                : '↻ Rescan'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
