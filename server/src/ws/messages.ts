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
  // `epoch` (null = sala sin película) va aquí porque {t:'media'} solo llega a
  // quien tenía el socket abierto en el instante del cambio: el invitado que
  // aún no había puesto su nombre, o el que estaba reconectando, se quedarían
  // pegados a la generación anterior para siempre. Con la generación viva en el
  // `welcome`, el cliente compara y se pone al día por su cuenta.
  | { t: 'welcome'; self: Participant; participants: Participant[]; state: PlaybackState; serverNow: number; history: ChatEntry[]; epoch: number | null }
  | { t: 'state'; state: PlaybackState; serverNow: number }
  | { t: 'presence'; participants: Participant[] }
  | { t: 'chat'; entry: ChatEntry }
  | { t: 'reaction'; emoji: string; fromId: string }
  | { t: 'buffering'; name: string; value: boolean }
  | { t: 'error'; log: string[] }
  // El cliente refetchea GET /api/rooms/:token y remonta el reproductor con
  // `epoch` como key. No se manda la info aquí para no duplicar la forma de esa
  // respuesta en dos sitios que puedan divergir.
  | { t: 'media'; epoch: number }
