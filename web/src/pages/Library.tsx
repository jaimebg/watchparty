import { useEffect, useState } from 'react'
import { addMediaFolder, bootstrapAdmin, createRoom, getLibrary, getStatus, pickMediaFolder } from '../api'
import type { LibraryItem } from '../types'

export function Library() {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [guest, setGuest] = useState(false)
  const [folderPath, setFolderPath] = useState('')
  const [folderError, setFolderError] = useState<string | null>(null)
  const [addingFolder, setAddingFolder] = useState(false)

  const load = async () => {
    try {
      if (await bootstrapAdmin(location.search)) history.replaceState(null, '', location.pathname)
      setItems(await getLibrary())
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

  const submitFolder = async () => {
    const trimmed = folderPath.trim()
    if (!trimmed) return
    setAddingFolder(true)
    setFolderError(null)
    try {
      const list = await addMediaFolder(trimmed)
      setItems(list)
      setFolderPath('')
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e))
    } finally {
      setAddingFolder(false)
    }
  }

  const browseFolder = async () => {
    setAddingFolder(true)
    setFolderError(null)
    try {
      const list = await pickMediaFolder()
      if (list) setItems(list)
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e))
    } finally {
      setAddingFolder(false)
    }
  }

  useEffect(() => { load() }, [])

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

  if (items.length === 0) {
    return (
      <main className="page">
        <h1>🎬 Biblioteca</h1>
        <p>Aún no hay carpetas de medios configuradas.</p>
        <section>
          <h2>Añade tu primera carpeta de medios</h2>
          <button onClick={() => void browseFolder()} disabled={addingFolder} autoFocus>
            {addingFolder ? 'Esperando…' : '📁 Elegir carpeta…'}
          </button>
          <p className="hint">Se abre el diálogo de tu sistema (mira el Finder/Explorador si no lo ves).</p>
          <details>
            <summary>O escribe la ruta a mano</summary>
            <form className="name-form" onSubmit={e => { e.preventDefault(); void submitFolder() }}>
              <input
                value={folderPath}
                onChange={e => setFolderPath(e.target.value)}
                placeholder="/ruta/absoluta/a/tus/vídeos"
              />
              <button type="submit" disabled={addingFolder}>{addingFolder ? 'Añadiendo…' : 'Añadir carpeta'}</button>
            </form>
          </details>
          {folderError && <p className="field-error">{folderError}</p>}
        </section>
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
    </main>
  )
}
