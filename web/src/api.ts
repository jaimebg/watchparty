import type { LibraryItem, RoomInfo, GifResult } from './types'

const json = async <T>(r: Response): Promise<T> => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

// The page is served statically, so the ?key= in the startup URL never goes
// through the server's admin hook: it has to be exchanged for the cookie with an
// API call.
export const bootstrapAdmin = async (search: string): Promise<boolean> => {
  const key = new URLSearchParams(search).get('key')
  if (!key) return false
  await fetch(`/api/status?key=${encodeURIComponent(key)}`)
  return true
}

export const getLibrary = () => fetch('/api/library').then(r => json<LibraryItem[]>(r))

// Without an itemId the server creates an empty room: the host hands out the
// link and picks a movie later, with people already inside.
export const createRoom = (itemId?: string) =>
  fetch('/api/rooms', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(itemId === undefined ? {} : { itemId }),
  }).then(r => json<{ token: string }>(r))

export const rescanLibrary = () =>
  fetch('/api/library/rescan', { method: 'POST' }).then(r => json<LibraryItem[]>(r))

// `by` is the host's own name, which their browser knows from the `welcome`:
// the server cannot know that the admin cookie is the participant named "Alex".
export const setRoomMedia = async (token: string, itemId: string, by?: string) => {
  const r = await fetch(`/api/rooms/${token}/media`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemId, by }),
  })
  if (!r.ok) {
    const body = await r.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${r.status}`)
  }
  return r.json() as Promise<{ epoch: number }>
}

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
// Opens the native folder picker ON THE HOST'S MACHINE (the browser cannot hand
// out absolute paths). Returns the updated library, or null if it was cancelled.
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
