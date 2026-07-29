import type { ChatEntry, Participant, ServerMsg } from '../types'

export interface ChatState {
  entries: ChatEntry[]; participants: Participant[]
  buffering: string[]; reactions: { id: number; emoji: string }[]
}

export const initialChat: ChatState = { entries: [], participants: [], buffering: [], reactions: [] }
let reactionId = 0

export function resetReactionIds(): void {
  reactionId = 0
}

export function chatReducer(s: ChatState, m: ServerMsg): ChatState {
  switch (m.t) {
    case 'welcome': return { ...s, entries: m.history, participants: m.participants }
    case 'chat': return { ...s, entries: [...s.entries, m.entry].slice(-500) }
    case 'presence': return { ...s, participants: m.participants }
    case 'buffering': return { ...s, buffering: m.value ? [...new Set([...s.buffering, m.name])] : s.buffering.filter(n => n !== m.name) }
    case 'reaction': return { ...s, reactions: [...s.reactions, { id: ++reactionId, emoji: m.emoji }] }
    default: return s
  }
}

export const dropReaction = (s: ChatState, id: number): ChatState =>
  ({ ...s, reactions: s.reactions.filter(r => r.id !== id) })
