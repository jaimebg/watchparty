import { useEffect, useState } from 'react'
import { addMediaFolder, bootstrapAdmin, createRoom, getLibrary, getMediaFolders, getStatus, pickMediaFolder, removeMediaFolder } from '../api'
import type { LibraryItem } from '../types'

export function Library() {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [guest, setGuest] = useState(false)
  const [folderPath, setFolderPath] = useState('')
  const [folderError, setFolderError] = useState<string | null>(null)
  const [busyFolders, setBusyFolders] = useState(false)

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

  const start = async (item: LibraryItem) => {
    try {
      const { token } = await createRoom(item.id)
      const { tunnelUrl } = await getStatus()
      const url = `${tunnelUrl ?? location.origin}/room/${token}`
      await navigator.clipboard.writeText(url).catch(() => {})
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
    return (
      <main className="page">
        <h1>🎬 jbg-watchparty</h1>
        <p>Para ver la sesión necesitas el <strong>enlace de sala</strong> que comparte el host
          — termina en <code>/room/…</code>. Pídeselo y ábrelo tal cual.</p>
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
  if (!items) return <main className="page"><p>Cargando…</p></main>

  const foldersSection = (
    <section className="folders-box">
      {folders.length > 0 && (
        <ul className="folders-list">
          {folders.map(f => (
            <li key={f}>
              <code>{f}</code>
              <button className="btn-small" disabled={busyFolders}
                onClick={() => void folderOp(() => removeMediaFolder(f))}>Quitar</button>
            </li>
          ))}
        </ul>
      )}
      <button onClick={() => void folderOp(pickMediaFolder)} disabled={busyFolders}>
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
        <h1>🎬 Biblioteca</h1>
        <p>{folders.length === 0
          ? 'Aún no hay carpetas de medios configuradas.'
          : 'Las carpetas configuradas no contienen vídeos (MKV, MP4, AVI, M4V, WebM).'}</p>
        <h2>{folders.length === 0 ? 'Añade tu primera carpeta de medios' : 'Carpetas de medios'}</h2>
        {foldersSection}
      </main>
    )
  }

  const groups = [...new Set(items.map(i => i.folderName))]
  return (
    <main className="page">
      <h1>🎬 Biblioteca</h1>
      {groups.map(g => (
        <section key={g}>
          <h2>{g}</h2>
          <ul>{items.filter(i => i.folderName === g).map(i => (
            <li key={i.id}><button onClick={() => start(i)}>{i.title}</button></li>
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
