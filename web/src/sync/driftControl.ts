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

// Tipado estructural en vez de `TimeRanges` para poder testearlo sin DOM.
export interface Ranges { length: number; start(i: number): number; end(i: number): number }

// Segundos contiguos ya descargados a partir de `t`; 0 si `t` cae fuera de todo
// rango. La tolerancia en el borde inicial evita que un `t` justo en la frontera
// de un rango se lea como «nada bufferizado» por un error de coma flotante.
export function bufferedAhead(ranges: Ranges, t: number): number {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) - 0.1 <= t && t < ranges.end(i)) return ranges.end(i) - t
  }
  return 0
}
