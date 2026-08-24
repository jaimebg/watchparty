import type { ChatEntry, Participant, ServerMsg } from '../types'

export interface ReactionFlash { id: number; emoji: string }

export interface ChatState {
  entries: ChatEntry[]; participants: Participant[]
  buffering: string[]; reactions: { id: number; emoji: string }[]
  // Each participant's last emoji, indexed by their id (not by name: two guests
  // can share one). It expires on its own, via animationend.
  flashes: Record<string, ReactionFlash>
}

export const initialChat: ChatState = { entries: [], participants: [], buffering: [], reactions: [], flashes: {} }
let reactionId = 0

export function resetReactionIds(): void {
  reactionId = 0
}

// Someone who reacts and leaves right after takes their chip out of the DOM, so
// its animationend never arrives and their flash would hang around.
function pruneFlashes(flashes: Record<string, ReactionFlash>, participants: Participant[]): Record<string, ReactionFlash> {
  const live = new Set(participants.map(p => p.id))
  const next: Record<string, ReactionFlash> = {}
  for (const pid of Object.keys(flashes)) if (live.has(pid)) next[pid] = flashes[pid]
  return next
}

export function chatReducer(s: ChatState, m: ServerMsg): ChatState {
  switch (m.t) {
    // Reset buffering too: a `buffering:false` broadcast missed while
    // disconnected would otherwise leave a stale "X is buffering…" forever,
    // since welcome is the only signal that we're rejoining from scratch.
    // The flashes reset for the same reason: a backgrounded tab does not run
    // animations, so one could survive the reconnect.
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

// It only removes when the id matches: if that person has reacted again in the
// meantime, the old flash's animationend must not take the new one down.
export const dropFlash = (s: ChatState, pid: string, id: number): ChatState => {
  if (s.flashes[pid]?.id !== id) return s
  const next = { ...s.flashes }
  delete next[pid]
  return { ...s, flashes: next }
}
