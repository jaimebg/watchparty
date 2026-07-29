import { describe, it, expect } from 'vitest'
import { computeCorrection, targetPosition } from '../src/sync/driftControl'

describe('computeCorrection', () => {
  it.each([
    [100, 100.1, 'none'], [100, 99.5, 'rate'], [100, 101.5, 'rate'], [100, 90, 'seek'],
  ])('target=%d actual=%d -> %s', (t, a, kind) => {
    expect(computeCorrection(t, a).kind).toBe(kind)
  })
  it('speeds up when behind, slows when ahead', () => {
    expect(computeCorrection(100, 99)).toEqual({ kind: 'rate', rate: 1.05 })
    expect(computeCorrection(100, 101)).toEqual({ kind: 'rate', rate: 0.95 })
  })
  it('seek carries target', () => {
    expect(computeCorrection(50, 10)).toEqual({ kind: 'seek', to: 50 })
  })
})

describe('targetPosition', () => {
  it('compensates clock offset while playing', () => {
    const state = { paused: false, positionBase: 100, updatedAt: 1000 }
    expect(targetPosition(state, 1000, 5000, 8000)).toBeCloseTo(103)
  })
  it('frozen when paused', () => {
    const state = { paused: true, positionBase: 100, updatedAt: 1000 }
    expect(targetPosition(state, 1000, 5000, 99000)).toBe(100)
  })
})
