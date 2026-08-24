import type { PlaybackState } from '../types'

export type Correction = { kind: 'none' } | { kind: 'rate'; rate: number } | { kind: 'seek'; to: number }

export function computeCorrection(targetSec: number, actualSec: number): Correction {
  const d = targetSec - actualSec
  const abs = Math.abs(d)
  if (abs < 0.3) return { kind: 'none' }
  if (abs <= 2) return { kind: 'rate', rate: d > 0 ? 1.05 : 0.95 }
  return { kind: 'seek', to: targetSec }
}

const positionAt = (s: PlaybackState, now: number) =>
  s.paused || s.stalled ? s.positionBase : s.positionBase + (now - s.updatedAt) / 1000

export function targetPosition(state: PlaybackState, serverNow: number, receivedAt: number, now: number): number {
  return positionAt(state, serverNow + (now - receivedAt))
}

// Structurally typed rather than `TimeRanges`, so it can be tested without a DOM.
export interface Ranges { length: number; start(i: number): number; end(i: number): number }

// Contiguous seconds already downloaded from `t` onwards; 0 when `t` falls
// outside every range. The tolerance at the leading edge stops a `t` sitting
// exactly on a range boundary reading as "nothing buffered" through a
// floating-point error.
export function bufferedAhead(ranges: Ranges, t: number): number {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) - 0.1 <= t && t < ranges.end(i)) return ranges.end(i) - t
  }
  return 0
}
