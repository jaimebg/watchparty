export interface PlaybackState {
  paused: boolean
  positionBase: number
  updatedAt: number
}

export type SyncAction =
  | { type: 'play'; at: number }
  | { type: 'pause'; at: number }
  | { type: 'seek'; position: number; at: number }

export const initialState = (at: number): PlaybackState => ({
  paused: true,
  positionBase: 0,
  updatedAt: at,
})

export const positionAt = (s: PlaybackState, now: number): number =>
  s.paused ? s.positionBase : s.positionBase + (now - s.updatedAt) / 1000

export function apply(s: PlaybackState, a: SyncAction): PlaybackState {
  switch (a.type) {
    case 'play':
      return { paused: false, positionBase: positionAt(s, a.at), updatedAt: a.at }
    case 'pause':
      return { paused: true, positionBase: positionAt(s, a.at), updatedAt: a.at }
    case 'seek':
      return { paused: s.paused, positionBase: a.position, updatedAt: a.at }
  }
}
