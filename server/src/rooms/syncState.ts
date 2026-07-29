export interface PlaybackState {
  paused: boolean
  positionBase: number
  updatedAt: number
  // Distinto de `paused`: `paused` es la intención del usuario (y lo que pinta
  // el botón de play), `stalled` es «el grupo espera al que está cargando».
  // Ambos congelan la posición, pero solo uno de los dos es del usuario.
  stalled: boolean
}

export type SyncAction =
  | { type: 'play'; at: number }
  | { type: 'pause'; at: number }
  | { type: 'seek'; position: number; at: number }
  | { type: 'stall'; at: number }
  | { type: 'resume'; at: number }

export const initialState = (at: number): PlaybackState => ({
  paused: true,
  positionBase: 0,
  updatedAt: at,
  stalled: false,
})

export const positionAt = (s: PlaybackState, now: number): number =>
  s.paused || s.stalled ? s.positionBase : s.positionBase + (now - s.updatedAt) / 1000

export function apply(s: PlaybackState, a: SyncAction): PlaybackState {
  switch (a.type) {
    case 'play':
      return { ...s, paused: false, positionBase: positionAt(s, a.at), updatedAt: a.at }
    case 'pause':
      return { ...s, paused: true, positionBase: positionAt(s, a.at), updatedAt: a.at }
    case 'seek':
      return { ...s, positionBase: a.position, updatedAt: a.at }
    case 'stall':
      return { ...s, positionBase: positionAt(s, a.at), stalled: true, updatedAt: a.at }
    // Recomputar positionBase es un no-op mientras stalled siga true (positionAt
    // lo devuelve congelado), pero deja el resume auto-corregido frente a un
    // despacho redundante o fuera de orden, igual que play/pause.
    case 'resume':
      return { ...s, positionBase: positionAt(s, a.at), stalled: false, updatedAt: a.at }
  }
}
