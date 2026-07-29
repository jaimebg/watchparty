import type { LibraryItem, RoomInfo, GifResult } from './types'

const json = async <T>(r: Response): Promise<T> => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

export const getLibrary = () => fetch('/api/library').then(r => json<LibraryItem[]>(r))
export const createRoom = (itemId: string) =>
  fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId }) }).then(r => json<{ token: string }>(r))
export const getRoom = (token: string) => fetch(`/api/rooms/${token}`).then(r => json<RoomInfo>(r))
export const getStatus = () => fetch('/api/status').then(r => json<{ tunnelUrl: string | null }>(r))
export const searchGifs = async (q: string, room: string) => {
  const r = await fetch(`/api/gifs/search?q=${encodeURIComponent(q)}&room=${room}`)
  if (r.status === 404) return { gifsDisabled: true as const }
  return json<{ results: GifResult[] }>(r)
}
