import type { PlaybackState } from '../rooms/syncState.js'

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
  // `epoch` (null = room with no movie) goes here because {t:'media'} only
  // reaches whoever had the socket open at the instant of the change: the guest
  // who had not yet entered their name, or the one who was reconnecting, would
  // be stuck on the previous generation forever. With the live generation in the
  // `welcome`, the client compares and catches up on its own.
  | { t: 'welcome'; self: Participant; participants: Participant[]; state: PlaybackState; serverNow: number; history: ChatEntry[]; epoch: number | null }
  | { t: 'state'; state: PlaybackState; serverNow: number }
  | { t: 'presence'; participants: Participant[] }
  | { t: 'chat'; entry: ChatEntry }
  | { t: 'reaction'; emoji: string; fromId: string }
  | { t: 'buffering'; name: string; value: boolean }
  | { t: 'error'; log: string[] }
  // The client refetches GET /api/rooms/:token and remounts the player with
  // `epoch` as the key. The info is not sent here so that response's shape is
  // not duplicated in two places that could drift apart.
  | { t: 'media'; epoch: number }
