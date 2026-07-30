import type { ChatEntry, Participant, ServerMsg } from '../types'

export interface ReactionFlash { id: number; emoji: string }

export interface ChatState {
  entries: ChatEntry[]; participants: Participant[]
  buffering: string[]; reactions: { id: number; emoji: string }[]
  // Último emoji de cada participante, indexado por su id (no por nombre: dos
  // invitados pueden llamarse igual). Caduca solo, por animationend.
  flashes: Record<string, ReactionFlash>
}

export const initialChat: ChatState = { entries: [], participants: [], buffering: [], reactions: [], flashes: {} }
let reactionId = 0

export function resetReactionIds(): void {
  reactionId = 0
}

// Quien reacciona y se marcha acto seguido deja su chip fuera del DOM, así que
// su animationend no llega nunca y su destello se quedaría colgado.
function pruneFlashes(flashes: Record<string, ReactionFlash>, participants: Participant[]): Record<string, ReactionFlash> {
  const live = new Set(participants.map(p => p.id))
  const next: Record<string, ReactionFlash> = {}
  for (const pid of Object.keys(flashes)) if (live.has(pid)) next[pid] = flashes[pid]
  return next
}

export function chatReducer(s: ChatState, m: ServerMsg): ChatState {
  switch (m.t) {
    // Reset buffering too: a `buffering:false` broadcast missed while
    // disconnected would otherwise leave a stale "X está cargando…" forever,
    // since welcome is the only signal that we're rejoining from scratch.
    // Los destellos se reinician por lo mismo: una pestaña en segundo plano no
    // ejecuta animaciones, así que uno podría sobrevivir a la reconexión.
    case 'welcome': return { ...s, entries: m.history, participants: m.participants, buffering: [], flashes: {} }
    case 'chat': return { ...s, entries: [...s.entries, m.entry].slice(-500) }
    case 'presence': return { ...s, participants: m.participants, flashes: pruneFlashes(s.flashes, m.participants) }
    case 'buffering': return { ...s, buffering: m.value ? [...new Set([...s.buffering, m.name])] : s.buffering.filter(n => n !== m.name) }
    case 'reaction': {
      const id = ++reactionId
      return {
        ...s,
        reactions: [...s.reactions, { id, emoji: m.emoji }],
        flashes: { ...s.flashes, [m.fromId]: { id, emoji: m.emoji } },
      }
    }
    default: return s
  }
}

export const dropReaction = (s: ChatState, id: number): ChatState =>
  ({ ...s, reactions: s.reactions.filter(r => r.id !== id) })

// Solo retira si el id coincide: si esa persona ha vuelto a reaccionar mientras
// tanto, el animationend del destello viejo no debe llevarse por delante al nuevo.
export const dropFlash = (s: ChatState, pid: string, id: number): ChatState => {
  if (s.flashes[pid]?.id !== id) return s
  const next = { ...s.flashes }
  delete next[pid]
  return { ...s, flashes: next }
}
