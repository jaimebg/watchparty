import type { LibraryItem, RoomInfo, GifResult } from './types'

const json = async <T>(r: Response): Promise<T> => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

// La página se sirve como estático, así que el ?key= de la URL de arranque no pasa por
// el hook admin del servidor: hay que canjearlo por la cookie con una llamada a la API.
export const bootstrapAdmin = async (search: string): Promise<boolean> => {
  const key = new URLSearchParams(search).get('key')
  if (!key) return false
  await fetch(`/api/status?key=${encodeURIComponent(key)}`)
  return true
}

export const getLibrary = () => fetch('/api/library').then(r => json<LibraryItem[]>(r))
export const createRoom = (itemId: string) =>
  fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId }) }).then(r => json<{ token: string }>(r))
export const getMediaFolders = () =>
  fetch('/api/config/folders').then(r => json<{ folders: string[] }>(r)).then(b => b.folders)

export const removeMediaFolder = async (path: string): Promise<LibraryItem[]> => {
  const r = await fetch('/api/config/folders', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
  return json<LibraryItem[]>(r)
}

export const addMediaFolder = async (path: string): Promise<LibraryItem[]> => {
  const r = await fetch('/api/config/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })
  if (!r.ok) {
    const body = await r.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${r.status}`)
  }
  return r.json() as Promise<LibraryItem[]>
}
// Abre el selector nativo de carpetas EN LA MÁQUINA DEL HOST (el navegador no puede
// dar rutas absolutas). Devuelve la biblioteca actualizada, o null si se canceló.
export const pickMediaFolder = async (): Promise<LibraryItem[] | null> => {
  const r = await fetch('/api/config/pick-folder', { method: 'POST' })
  if (!r.ok) {
    const body = await r.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${r.status}`)
  }
  const body = await r.json() as LibraryItem[] | { cancelled: true }
  return Array.isArray(body) ? body : null
}

export const getRoom = (token: string) => fetch(`/api/rooms/${token}`).then(r => json<RoomInfo>(r))
export const getStatus = () => fetch('/api/status').then(r => json<{ tunnelUrl: string | null }>(r))
export const searchGifs = async (q: string, room: string) => {
  const r = await fetch(`/api/gifs/search?q=${encodeURIComponent(q)}&room=${room}`)
  if (r.status === 404) return { gifsDisabled: true as const }
  return json<{ results: GifResult[] }>(r)
}
