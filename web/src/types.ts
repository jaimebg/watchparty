// Espejo de los tipos del server (sin dependencia cruzada entre workspaces en v1).

// server/src/library/scanner.ts
export interface LibraryItem {
  id: string; path: string; title: string
  folderName: string
  /** Ruta absoluta de la carpeta: identifica el grupo, porque dos series pueden
   *  tener una «Season 1» cada una y el basename las fusionaría. */
  folderPath: string
  srtFiles: string[]
}

// server/src/media/probe.ts
export interface AudioTrack { index: number; codec: string; lang: string; label: string; channels: number }

// server/src/media/subtitles.ts
export interface SubtitleOption { id: number; label: string; lang: string }

// server/src/rooms/syncState.ts
export interface PlaybackState {
  paused: boolean
  positionBase: number
  updatedAt: number
  stalled: boolean
}

// server/src/ws/messages.ts
export interface Participant { id: string; name: string; color: string; active: boolean }
export interface ChatEntry { id: string; from: Participant; kind: 'text' | 'gif' | 'system'; text: string; gifUrl?: string; at: number }

export type ClientMsg =
  | { t: 'join'; name: string }
  | { t: 'play' } | { t: 'pause' } | { t: 'seek'; position: number }
  | { t: 'chat'; text: string }
  | { t: 'gif'; url: string }
  | { t: 'reaction'; emoji: string }
  | { t: 'buffering'; value: boolean }
  | { t: 'visibility'; active: boolean }

export type ServerMsg =
  // `epoch` (null = sala sin película) es la generación viva en el servidor: el
  // cliente la compara con la suya al recibir el `welcome` porque {t:'media'}
  // solo lo vio quien tenía el socket abierto en ese instante.
  | { t: 'welcome'; self: Participant; participants: Participant[]; state: PlaybackState; serverNow: number; history: ChatEntry[]; epoch: number | null }
  | { t: 'state'; state: PlaybackState; serverNow: number }
  | { t: 'presence'; participants: Participant[] }
  | { t: 'chat'; entry: ChatEntry }
  | { t: 'reaction'; emoji: string; fromId: string }
  | { t: 'buffering'; name: string; value: boolean }
  | { t: 'error'; log: string[] }
  | { t: 'media'; epoch: number }

// server/src/http/klipy.ts
export interface GifResult { id: string; title: string; previewUrl: string; url: string; width: number; height: number }

// server/src/http/api.ts (GET /api/rooms/:token response shape)
export interface RoomMeta {
  title: string
  year: number | null
  overview: string
  posterUrl: string | null
  rating: number | null
  episodeTag: string | null
  originalLang: string | null
}

export interface RoomMediaInfo {
  /** Generación de película de la sala: versiona las URLs y remonta el player. */
  epoch: number
  /** Id del ítem de biblioteca en emisión: identifica la película sin depender
   *  de cómo se pinte su título (`title` pasa por displayTitle y no coincide con
   *  el `title` de LibraryItem en cuanto TMDB resuelve). */
  itemId: string
  title: string
  durationSec: number
  audio: AudioTrack[]
  subtitles: SubtitleOption[]
  meta: RoomMeta | null
}

export interface RoomInfo {
  /** null = el host todavía no ha elegido película. */
  media: RoomMediaInfo | null
  error: string[] | null
  // Origen del que pedir el vídeo; '' = mismo origen que la app. Al nivel
  // superior y no dentro de `media`: describe dónde vive el servidor, no la
  // película, y hace falta igual en una sala vacía.
  streamBase: string
}
