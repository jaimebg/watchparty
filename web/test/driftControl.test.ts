import { describe, it, expect } from 'vitest'
import { computeCorrection, targetPosition, bufferedAhead } from '../src/sync/driftControl'

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
    const state = { paused: false, positionBase: 100, updatedAt: 1000, stalled: false }
    expect(targetPosition(state, 1000, 5000, 8000)).toBeCloseTo(103)
  })
  it('frozen when paused', () => {
    const state = { paused: true, positionBase: 100, updatedAt: 1000, stalled: false }
    expect(targetPosition(state, 1000, 5000, 99000)).toBe(100)
  })
  it('frozen when stalled even though it is not paused', () => {
    const state = { paused: false, positionBase: 100, updatedAt: 1000, stalled: true }
    expect(targetPosition(state, 1000, 5000, 99000)).toBe(100)
  })
})

const ranges = (...pairs: [number, number][]) => ({
  length: pairs.length,
  start: (i: number) => pairs[i][0],
  end: (i: number) => pairs[i][1],
})

describe('bufferedAhead', () => {
  it('returns the contiguous seconds available from t', () => {
    expect(bufferedAhead(ranges([10, 25]), 12)).toBeCloseTo(13)
  })
  it('is 0 in a hole between ranges', () => {
    expect(bufferedAhead(ranges([0, 10], [30, 40]), 20)).toBe(0)
  })
  it('is 0 with nothing buffered', () => {
    expect(bufferedAhead(ranges(), 5)).toBe(0)
  })
  it('counts a t sitting exactly on the start edge', () => {
    expect(bufferedAhead(ranges([10, 25]), 10)).toBeCloseTo(15)
  })
  it('is 0 past the end edge', () => {
    expect(bufferedAhead(ranges([10, 25]), 25)).toBe(0)
  })
  it('picks the range that contains t, not the first one', () => {
    expect(bufferedAhead(ranges([0, 10], [30, 40]), 32)).toBeCloseTo(8)
  })
})
