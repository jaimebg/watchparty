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
  s.paused ? s.positionBase : s.positionBase + (now - s.updatedAt) / 1000

export function targetPosition(state: PlaybackState, serverNow: number, receivedAt: number, now: number): number {
  return positionAt(state, serverNow + (now - receivedAt))
}
