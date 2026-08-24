// A mirror of the server's types (no cross-workspace dependency in v1).

// server/src/library/scanner.ts
export interface LibraryItem {
  id: string; path: string; title: string
  folderName: string
  /** Absolute path of the folder: it identifies the group, because two series
   *  can each have a "Season 1" and the basename would merge them. */
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
  // `epoch` (null = room with no movie) is the live generation on the server:
  // the client compares it with its own on receiving the `welcome`, because
  // {t:'media'} was only seen by whoever had the socket open at that instant.
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
  /** The room's movie generation: it versions the URLs and remounts the player. */
  epoch: number
  /** Id of the library item now playing: it identifies the movie without
   *  depending on how its title renders (`title` goes through displayTitle and
   *  stops matching LibraryItem's `title` the moment TMDB resolves). */
  itemId: string
  title: string
  durationSec: number
  audio: AudioTrack[]
  subtitles: SubtitleOption[]
  meta: RoomMeta | null
}

export interface RoomInfo {
  /** null = the host has not picked a movie yet. */
  media: RoomMediaInfo | null
  error: string[] | null
  // The origin to fetch video from; '' = the same origin as the app. At the top
  // level and not inside `media`: it describes where the server lives, not the
  // movie, and it is needed just as much in an empty room.
  streamBase: string
}
