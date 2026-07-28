import { describe, it, expect } from 'vitest'
import { initialState, positionAt, apply } from '../src/rooms/syncState.js'

describe('syncState', () => {
  it('starts paused at 0', () => {
    const s = initialState(1000)
    expect(positionAt(s, 99_999)).toBe(0)
  })
  it('advances while playing, freezes on pause', () => {
    let s = apply(initialState(0), { type: 'play', at: 0 })
    expect(positionAt(s, 10_000)).toBeCloseTo(10)
    s = apply(s, { type: 'pause', at: 10_000 })
    expect(positionAt(s, 60_000)).toBeCloseTo(10)
  })
  it('seek moves position preserving paused flag', () => {
    let s = apply(initialState(0), { type: 'play', at: 0 })
    s = apply(s, { type: 'seek', position: 300, at: 5_000 })
    expect(s.paused).toBe(false)
    expect(positionAt(s, 7_000)).toBeCloseTo(302)
  })
})
