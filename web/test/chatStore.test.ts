import { describe, it, expect, beforeEach } from 'vitest'
import { chatReducer, initialChat, dropFlash, dropReaction, resetReactionIds, type ChatState } from '../src/chat/chatStore'

const p = { id: 'u1', name: 'Ana', color: '#f00', active: true }
const entry = (text: string) => ({ id: text, from: p, kind: 'text' as const, text, at: 1 })

describe('chatReducer', () => {
  beforeEach(() => {
    resetReactionIds()
  })

  it('welcome seeds history and participants', () => {
    const s = chatReducer(initialChat, { t: 'welcome', self: p, participants: [p], state: { paused: true, positionBase: 0, updatedAt: 0 }, serverNow: 0, history: [entry('hi')] } as any)
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
    s = chatReducer(s, { t: 'chat', entry: entry('newest') } as any)
    expect(s.entries).toHaveLength(500)
    expect(s.entries.at(-1)!.text).toBe('newest')
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

  it('a reaction leaves a flash indexed by participant', () => {
    const s = chatReducer(initialChat, { t: 'reaction', emoji: '🔥', fromId: 'u1' } as any)
    expect(s.flashes).toEqual({ u1: { id: 1, emoji: '🔥' } })
    // The overlay and the flash share the same id.
    expect(s.reactions).toEqual([{ id: 1, emoji: '🔥' }])
  })

  it('a new flash from the same participant replaces the previous one', () => {
    let s = chatReducer(initialChat, { t: 'reaction', emoji: '🔥', fromId: 'u1' } as any)
    s = chatReducer(s, { t: 'reaction', emoji: '😂', fromId: 'u1' } as any)
    expect(s.flashes).toEqual({ u1: { id: 2, emoji: '😂' } })
  })

  it('dropFlash with a stale id does not delete the new flash', () => {
    let s = chatReducer(initialChat, { t: 'reaction', emoji: '🔥', fromId: 'u1' } as any)
    s = chatReducer(s, { t: 'reaction', emoji: '😂', fromId: 'u1' } as any)
    // The first flash's animationend arrives late.
    expect(dropFlash(s, 'u1', 1).flashes).toEqual({ u1: { id: 2, emoji: '😂' } })
    expect(dropFlash(s, 'u1', 2).flashes).toEqual({})
  })

  it('welcome clears the flashes', () => {
    let s = chatReducer(initialChat, { t: 'reaction', emoji: '🔥', fromId: 'u1' } as any)
    s = chatReducer(s, { t: 'welcome', self: p, participants: [p], state: { paused: true, positionBase: 0, updatedAt: 0 }, serverNow: 0, history: [] } as any)
    expect(s.flashes).toEqual({})
  })

  it('presence prunes the flash of whoever has left and keeps the rest', () => {
    let s = chatReducer(initialChat, { t: 'reaction', emoji: '🔥', fromId: 'u1' } as any)
    s = chatReducer(s, { t: 'reaction', emoji: '😂', fromId: 'u2' } as any)
    s = chatReducer(s, { t: 'presence', participants: [p] } as any)
    expect(s.flashes).toEqual({ u1: { id: 1, emoji: '🔥' } })
  })
})
