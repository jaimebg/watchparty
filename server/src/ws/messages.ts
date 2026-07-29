import type { PlaybackState } from '../rooms/syncState.js'

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
