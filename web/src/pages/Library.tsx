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
    try {
      const { token } = await createRoom(item?.id)
      const { tunnelUrl } = await getStatus()
      await navigator.clipboard.writeText(roomLink(tunnelUrl ?? location.origin, token)).catch(() => {})
      location.pathname = `/room/${token}`
    } catch (e) {
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
      if (!token) { setRoomError('Eso no parece un código de sala. Pega el enlace completo o el código que va tras /room/.'); return }
      location.pathname = `/room/${token}`
    }
    return (
      <main className="page page--gate">
        <header className="masthead">
          <p className="eyebrow">JBG Watchparty</p>
          <h1>Función privada</h1>
          <div className="marquee-rule" aria-hidden="true" />
        </header>
        <p>Para ver la sesión necesitas el <strong>enlace de sala</strong> que comparte el host
          — termina en <code>/room/…</code>. Pídeselo y ábrelo tal cual.</p>
        <form className="name-form" onSubmit={e => { e.preventDefault(); enterRoom() }}>
          <input
            value={roomInput}
            onChange={e => { setRoomInput(e.target.value); setRoomError(null) }}
            placeholder="Código o enlace de la sala"
            aria-label="Código o enlace de la sala"
          />
          <button type="submit" className="btn-primary">Entrar</button>
        </form>
        {roomError && <p className="field-error">{roomError}</p>}
        {isLocal && (
          <p className="hint">¿Eres el host? Entra con la URL con <code>?key=…</code> que imprime la
            terminal al arrancar el servidor (se abre sola en el navegador).</p>
        )}
      </main>
    )
  }

  if (error) return (
    <main className="page">
      <p>No se pudo cargar la biblioteca. ({error})</p>
    </main>
  )
  if (!items) return <main className="page"><p className="loading">Encendiendo el proyector…</p></main>

  const foldersSection = (
    <section className="folders-box">
      {folders.length > 0 && (
        <ul className="folders-list">
          {folders.map(f => (
            <li key={f}>
              <code>{f}</code>
              <button type="button" className="btn-small" disabled={busyFolders}
                onClick={() => void folderOp(() => removeMediaFolder(f))}>Quitar</button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn-primary" onClick={() => void folderOp(pickMediaFolder)} disabled={busyFolders}>
        {busyFolders ? 'Esperando…' : '📁 Añadir carpeta…'}
      </button>
      <p className="hint">Se abre el diálogo de tu sistema (mira el Finder/Explorador si no lo ves).</p>
      <details>
        <summary>O escribe la ruta a mano</summary>
        <form className="name-form" onSubmit={e => { e.preventDefault(); submitFolder() }}>
          <input
            value={folderPath}
            onChange={e => setFolderPath(e.target.value)}
            placeholder="/ruta/absoluta/a/tus/vídeos"
            aria-label="Ruta de la carpeta de medios"
          />
          <button type="submit" disabled={busyFolders}>{busyFolders ? 'Añadiendo…' : 'Añadir carpeta'}</button>
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
          <h1>La cartelera</h1>
          <div className="marquee-rule" aria-hidden="true" />
        </header>
        <p>{folders.length === 0
          ? 'Aún no hay nada en cartel: falta configurar carpetas de medios.'
          : 'Las carpetas configuradas no contienen vídeos (MKV, MP4, AVI, M4V, WebM).'}</p>
        <p>
          <button type="button" className="btn-primary" onClick={() => void start()}>
            🎬 Crear sala vacía
          </button>
        </p>
        <h2>{folders.length === 0 ? 'Añade tu primera carpeta de medios' : 'Carpetas de medios'}</h2>
        {foldersSection}
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
        <h1>La cartelera</h1>
        <div className="marquee-rule" aria-hidden="true" />
      </header>
      <p className="hint">
        <button type="button" className="btn-primary" onClick={() => void start()}>
          🎬 Crear sala vacía
        </button>
        {' '}Reparte el enlace ahora y elige la película dentro de la sala.
      </p>
      {groups.map(([path, name]) => (
        <section key={path} className="bill">
          <h2>{name}</h2>
          <ul className="film-list">{items.filter(i => i.folderPath === path).map((i, idx) => (
            <li key={i.id} style={{ animationDelay: `${Math.min(idx, 10) * 45}ms` }}>
              <button type="button" className="film-btn" onClick={() => void start(i)}>
                <span className="film-title">{i.title}</span>
                <span className="film-go" aria-hidden="true">Crear sala →</span>
              </button>
            </li>
          ))}</ul>
        </section>
      ))}
      <details className="folders-manage">
        <summary>⚙️ Carpetas de medios ({folders.length})</summary>
        {foldersSection}
      </details>
    </main>
  )
}
