import { useEffect, useState } from 'react'
import { createRoom, getLibrary, getStatus } from '../api'
import type { LibraryItem } from '../types'

export function Library() {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = async (item: LibraryItem) => {
    const { token } = await createRoom(item.id)
    const { tunnelUrl } = await getStatus()
    const url = `${tunnelUrl ?? location.origin}/room/${token}`
    await navigator.clipboard.writeText(url).catch(() => {})
    location.pathname = `/room/${token}`
  }

  useEffect(() => { getLibrary().then(setItems).catch(e => setError(String(e))) }, [])

  if (error) return <main className="page"><p>Solo el host puede ver la biblioteca. ({error})</p></main>
  if (!items) return <main className="page"><p>Cargando…</p></main>
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
