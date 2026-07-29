import { describe, it, expect, beforeEach } from 'vitest'
import { chatReducer, initialChat, dropReaction, resetReactionIds, type ChatState } from '../src/chat/chatStore'

const p = { id: 'u1', name: 'Ana', color: '#f00', active: true }
const entry = (text: string) => ({ id: text, from: p, kind: 'text' as const, text, at: 1 })

describe('chatReducer', () => {
  beforeEach(() => {
    resetReactionIds()
  })

  it('welcome seeds history and participants', () => {
    const s = chatReducer(initialChat, { t: 'welcome', self: p, participants: [p], state: { paused: true, positionBase: 0, updatedAt: 0 }, serverNow: 0, history: [entry('hola')] } as any)
    expect(s.entries).toHaveLength(1)
    expect(s.participants).toEqual([p])
  })
  it('welcome resets buffering so a stale indicator does not survive a reconnect', () => {
    const withStaleBuffering: ChatState = { ...initialChat, buffering: ['Ana'] }
    const s = chatReducer(withStaleBuffering, { t: 'welcome', self: p, participants: [p], state: { paused: true, positionBase: 0, updatedAt: 0 }, serverNow: 0, history: [] } as any)
    expect(s.buffering).toEqual([])
  })
  it('chat appends capped at 500', () => {
    let s: ChatState = { ...initialChat, entries: Array.from({ length: 500 }, (_, i) => entry(String(i))) }
    s = chatReducer(s, { t: 'chat', entry: entry('nuevo') } as any)
    expect(s.entries).toHaveLength(500)
    expect(s.entries.at(-1)!.text).toBe('nuevo')
  })
  it('buffering adds and removes names', () => {
    let s = chatReducer(initialChat, { t: 'buffering', name: 'Ana', value: true } as any)
    expect(s.buffering).toEqual(['Ana'])
    s = chatReducer(s, { t: 'buffering', name: 'Ana', value: false } as any)
    expect(s.buffering).toEqual([])
  })
  it('reactions get incremental ids and can be dropped', () => {
    let s = chatReducer(initialChat, { t: 'reaction', emoji: '🔥', from: 'Ana' } as any)
    s = chatReducer(s, { t: 'reaction', emoji: '❤️', from: 'Ana' } as any)
    expect(s.reactions.map(r => r.id)).toEqual([1, 2])
    expect(dropReaction(s, 1).reactions.map(r => r.id)).toEqual([2])
  })
})
