import { describe, it, expect } from 'vitest'
import { formatSystemEvent } from '../src/chat/systemText'

describe('formatSystemEvent', () => {
  it('names who joined, left, resumed or paused', () => {
    expect(formatSystemEvent({ type: 'join', name: 'Ana' }, 'en')).toBe('Ana joined')
    expect(formatSystemEvent({ type: 'left', name: 'Ana' }, 'en')).toBe('Ana left')
    expect(formatSystemEvent({ type: 'resumed', name: 'Ana' }, 'en')).toBe('Ana resumed')
    expect(formatSystemEvent({ type: 'paused', name: 'Ana' }, 'en')).toBe('Ana paused')
    expect(formatSystemEvent({ type: 'join', name: 'Ana' }, 'es')).toBe('Ana se unió')
    expect(formatSystemEvent({ type: 'left', name: 'Ana' }, 'es')).toBe('Ana salió')
    expect(formatSystemEvent({ type: 'resumed', name: 'Ana' }, 'es')).toBe('Ana reanudó')
    expect(formatSystemEvent({ type: 'paused', name: 'Ana' }, 'es')).toBe('Ana pausó')
  })

  it('formats the seek position with the clock formatter', () => {
    expect(formatSystemEvent({ type: 'seek', name: 'Ana', position: 80 }, 'en')).toBe('Ana jumped to 1:20')
    expect(formatSystemEvent({ type: 'seek', name: 'Ana', position: 3755 }, 'en')).toBe('Ana jumped to 1:02:35')
    expect(formatSystemEvent({ type: 'seek', name: 'Ana', position: 80 }, 'es')).toBe('Ana saltó a 1:20')
  })

  it('attributes the movie to whoever set it, or stays impersonal', () => {
    expect(formatSystemEvent({ type: 'nowPlaying', title: 'Heat', setBy: 'Alex' }, 'en')).toBe('Alex put on “Heat”')
    expect(formatSystemEvent({ type: 'nowPlaying', title: 'Heat', setBy: null }, 'en')).toBe('now playing “Heat”')
    expect(formatSystemEvent({ type: 'nowPlaying', title: 'Heat', setBy: 'Alex' }, 'es')).toBe('Alex puso «Heat»')
    expect(formatSystemEvent({ type: 'nowPlaying', title: 'Heat', setBy: null }, 'es')).toBe('ahora se ve «Heat»')
  })
})
