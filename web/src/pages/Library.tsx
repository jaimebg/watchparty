import { useEffect, useState } from 'react'
import { addMediaFolder, bootstrapAdmin, createRoom, getLibrary, getMediaFolders, getStatus, pickMediaFolder, removeMediaFolder } from '../api'
import type { LibraryItem } from '../types'
import { parseRoomToken, roomLink } from './roomToken'

export function Library() {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [guest, setGuest] = useState(false)
  const [folderPath, setFolderPath] = useState('')
  const [folderError, setFolderError] = useState<string | null>(null)
  const [busyFolders, setBusyFolders] = useState(false)
  const [roomInput, setRoomInput] = useState('')
  const [roomError, setRoomError] = useState<string | null>(null)
  // null = nada en marcha. El objeto describe la sala que se está montando:
  // `id`/`title` a null en la sala vacía, que no prepara ningún vídeo.
  const [starting, setStarting] = useState<{ id: string | null; title: string | null } | null>(null)

  const load = async () => {
    try {
      if (await bootstrapAdmin(location.search)) history.replaceState(null, '', location.pathname)
      setItems(await getLibrary())
      setFolders(await getMediaFolders())
    } catch (e) {
      // 401 = visitante sin cookie de admin: típico invitado que abrió la URL
      // pública base en vez del enlace de sala. No es un error, es una portada.
      if (e instanceof Error && e.message.includes('401')) setGuest(true)
      else setError(String(e))
    }
  }

  // Sin ítem: sala vacía. El enlace se copia igual, así que el host puede
  // repartirlo y elegir película con la gente ya dentro.
  const start = async (item?: LibraryItem) => {
    // Con película, `createRoom` no vuelve hasta que el servidor ha analizado
    // el vídeo, sacado los keyframes y extraído los subtítulos: segundos. Se
    // bloquea la reentrada porque dos clics impacientes crearían dos salas y el
    // enlace copiado sería el de la segunda.
    if (starting) return
    setStarting({ id: item?.id ?? null, title: item?.title ?? null })
    try {
      const { token } = await createRoom(item?.id)
      const { tunnelUrl } = await getStatus()
      await navigator.clipboard.writeText(roomLink(tunnelUrl ?? location.origin, token)).catch(() => {})
      // Sin limpiar `starting`: la navegación tarda en pintar y el cartel debe
      // seguir puesto hasta que se vaya la página.
      location.pathname = `/room/${token}`
    } catch (e) {
      setStarting(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Cualquier operación de carpetas devuelve la biblioteca reescaneada; la
  // lista de carpetas se refresca aparte (contrato estable con el server).
  const folderOp = async (op: () => Promise<LibraryItem[] | null>) => {
    setBusyFolders(true)
    setFolderError(null)
    try {
      const list = await op()
      if (list) setItems(list)
      setFolders(await getMediaFolders())
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyFolders(false)
    }
  }

  const submitFolder = () => {
    const trimmed = folderPath.trim()
    if (!trimmed) return
    void folderOp(async () => {
      const list = await addMediaFolder(trimmed)
      setFolderPath('')
      return list
    })
  }

  useEffect(() => { void load() }, [])

  if (guest) {
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname)
    const enterRoom = () => {
      const token = parseRoomToken(roomInput)
      if (!token) { setRoomError("That doesn't look like a room code. Paste the full link or the code after /room/."); return }
      location.pathname = `/room/${token}`
    }
    return (
      <main className="page page--gate">
        <header className="masthead">
          <p className="eyebrow">Watchparty</p>
          <h1>Private screening</h1>
          <div className="marquee-rule" aria-hidden="true" />
        </header>
        <p>To watch the session you need the <strong>room link</strong> the host shares.
          It ends in <code>/room/…</code>. Ask them for it and open it as is.</p>
        <form className="name-form" onSubmit={e => { e.preventDefault(); enterRoom() }}>
          <input
            value={roomInput}
            onChange={e => { setRoomInput(e.target.value); setRoomError(null) }}
            placeholder="Room code or link"
            aria-label="Room code or link"
          />
          <button type="submit" className="btn-primary">Join</button>
        </form>
        {roomError && <p className="field-error">{roomError}</p>}
        {isLocal && (
          <p className="hint">Are you the host? Enter through the <code>?key=…</code> URL printed by the
            terminal when the server starts (it opens in your browser on its own).</p>
        )}
      </main>
    )
  }

  if (error) return (
    <main className="page">
      <p>Couldn't load the library. ({error})</p>
    </main>
  )
  if (!items) return <main className="page"><p className="loading">Warming up the projector…</p></main>

  // Fijo sobre toda la página, así que se monta igual en las dos vistas de
  // cartelera (con títulos y sin ellos) sin importar dónde caiga en el árbol.
  const startingOverlay = starting && (
    <div className="busy-overlay" role="status" aria-live="polite">
      <span className="spinner spinner--lg" aria-hidden="true" />
      <p className="busy-title">
        {starting.title ? `Setting up the room for “${starting.title}”` : 'Setting up the room…'}
      </p>
      {starting.title && (
        <p className="hint">Analizamos el vídeo y preparamos los subtítulos: con
          películas largas puede tardar unos segundos.</p>
      )}
      <p className="hint">El enlace se copia al portapapeles en cuanto esté lista.</p>
    </div>
  )

  const emptyRoomButton = (
    <button type="button" className="btn-primary" disabled={starting !== null} onClick={() => void start()}>
      {starting && starting.id === null
        ? <><span className="spinner" aria-hidden="true" /> Setting up the room…</>
        : '🎬 Create empty room'}
    </button>
  )

  const foldersSection = (
    <section className="folders-box">
      {folders.length > 0 && (
        <ul className="folders-list">
          {folders.map(f => (
            <li key={f}>
              <code>{f}</code>
              <button type="button" className="btn-small" disabled={busyFolders}
                onClick={() => void folderOp(() => removeMediaFolder(f))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn-primary" onClick={() => void folderOp(pickMediaFolder)} disabled={busyFolders}>
        {busyFolders ? 'Waiting…' : '📁 Add folder…'}
      </button>
      <p className="hint">Your system's dialog opens (check Finder/File Explorer if you don't see it).</p>
      <details>
        <summary>Or type the path by hand</summary>
        <form className="name-form" onSubmit={e => { e.preventDefault(); submitFolder() }}>
          <input
            value={folderPath}
            onChange={e => setFolderPath(e.target.value)}
            placeholder="/absolute/path/to/your/videos"
            aria-label="Media folder path"
          />
          <button type="submit" disabled={busyFolders}>{busyFolders ? 'Adding…' : 'Add folder'}</button>
        </form>
      </details>
      {folderError && <p className="field-error">{folderError}</p>}
    </section>
  )

  if (items.length === 0) {
    return (
      <main className="page">
        <header className="masthead">
          <p className="eyebrow">JBG Watchparty</p>
          <h1>The marquee</h1>
          <div className="marquee-rule" aria-hidden="true" />
        </header>
        <p>{folders.length === 0
          ? 'Nothing on the marquee yet: no media folders configured.'
          : 'The configured folders contain no videos (MKV, MP4, AVI, M4V, WebM).'}</p>
        <p>{emptyRoomButton}</p>
        <h2>{folders.length === 0 ? 'Add your first media folder' : 'Media folders'}</h2>
        {foldersSection}
        {startingOverlay}
      </main>
    )
  }

  // Por folderPath y no por folderName: dos series con una «Season 1» cada una
  // se fusionarían en una sección con los episodios de ambas mezclados.
  const groups = [...new Map(items.map(i => [i.folderPath, i.folderName])).entries()]
  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">JBG Watchparty</p>
          <h1>The marquee</h1>
          <div className="marquee-rule" aria-hidden="true" />
        </header>
        <p className="hint">
          {emptyRoomButton}
          {' '}Share the link now and pick the movie inside the room.
      </p>
      {groups.map(([path, name]) => (
        <section key={path} className="bill">
          <h2>{name}</h2>
          <ul className="film-list">{items.filter(i => i.folderPath === path).map((i, idx) => (
            <li key={i.id} style={{ animationDelay: `${Math.min(idx, 10) * 45}ms` }}>
              <button type="button" className="film-btn" disabled={starting !== null} onClick={() => void start(i)}>
                <span className="film-title">{i.title}</span>
                {starting?.id === i.id ? (
                  <span className="film-go film-go--busy" aria-hidden="true">
                    <span className="spinner" /> Setting up…
                  </span>
                ) : (
                  <span className="film-go" aria-hidden="true">Create room →</span>
                )}
              </button>
            </li>
          ))}</ul>
        </section>
      ))}
      <details className="folders-manage">
        <summary>⚙️ Media folders ({folders.length})</summary>
        {foldersSection}
      </details>
      {startingOverlay}
    </main>
  )
}
