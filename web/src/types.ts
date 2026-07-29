// Espejo de los tipos del server (sin dependencia cruzada entre workspaces en v1).

// server/src/library/scanner.ts
export interface LibraryItem { id: string; path: string; title: string; folderName: string; srtFiles: string[] }

// server/src/media/probe.ts
export interface AudioTrack { index: number; codec: string; lang: string; label: string; channels: number }

// server/src/media/subtitles.ts
export interface SubtitleOption { id: number; label: string; lang: string }

// server/src/rooms/syncState.ts
export interface PlaybackState {
  paused: boolean
  positionBase: number
  updatedAt: number
}

// server/src/ws/messages.ts
export interface Participant { id: string; name: string; color: string }
export interface ChatEntry { id: string; from: Participant; kind: 'text' | 'gif' | 'system'; text: string; gifUrl?: string; at: number }

export type ClientMsg =
  | { t: 'join'; name: string }
  | { t: 'play' } | { t: 'pause' } | { t: 'seek'; position: number }
  | { t: 'chat'; text: string }
  | { t: 'gif'; url: string }
  | { t: 'reaction'; emoji: string }
  | { t: 'buffering'; value: boolean }

export type ServerMsg =
  | { t: 'welcome'; self: Participant; participants: Participant[]; state: PlaybackState; serverNow: number; history: ChatEntry[] }
  | { t: 'state'; state: PlaybackState; serverNow: number }
  | { t: 'presence'; participants: Participant[] }
  | { t: 'chat'; entry: ChatEntry }
  | { t: 'reaction'; emoji: string; from: string }
  | { t: 'buffering'; name: string; value: boolean }
  | { t: 'error'; log: string[] }

// server/src/http/klipy.ts
export interface GifResult { id: string; title: string; previewUrl: string; url: string; width: number; height: number }

// server/src/http/api.ts (GET /api/rooms/:token response shape)
export interface RoomInfo {
  title: string
  durationSec: number
  audio: AudioTrack[]
  subtitles: SubtitleOption[]
  error: string[] | null
}
