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
  it('stall freezes the clock where it was and resume restarts it from there', () => {
    let s = apply(initialState(0), { type: 'play', at: 0 })
    s = apply(s, { type: 'stall', at: 10_000 })
    expect(s.stalled).toBe(true)
    expect(s.paused).toBe(false)
    expect(positionAt(s, 60_000)).toBeCloseTo(10) // congelado aunque pase el tiempo
    s = apply(s, { type: 'resume', at: 60_000 })
    expect(s.stalled).toBe(false)
    expect(positionAt(s, 62_000)).toBeCloseTo(12) // sigue desde donde se congeló
  })

  it('play, pause and seek preserve the stalled flag', () => {
    let s = apply(apply(initialState(0), { type: 'play', at: 0 }), { type: 'stall', at: 1_000 })
    expect(apply(s, { type: 'pause', at: 2_000 }).stalled).toBe(true)
    expect(apply(s, { type: 'play', at: 2_000 }).stalled).toBe(true)
    expect(apply(s, { type: 'seek', position: 300, at: 2_000 }).stalled).toBe(true)
  })

  it('pausing while stalled keeps the frozen position, not the elapsed one', () => {
    let s = apply(apply(initialState(0), { type: 'play', at: 0 }), { type: 'stall', at: 5_000 })
    s = apply(s, { type: 'pause', at: 30_000 })
    expect(s.positionBase).toBeCloseTo(5) // no 30: el reloj estaba congelado
  })
})
