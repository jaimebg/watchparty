export interface PlaybackState {
  paused: boolean
  positionBase: number
  updatedAt: number
  // Distinct from `paused`: `paused` is the user's intent (and what the play
  // button renders), `stalled` means "the group is waiting for whoever is
  // loading". Both freeze the position, but only one of them is the user's.
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
    // Recomputing positionBase is a no-op while stalled stays true (positionAt
    // returns it frozen), but it leaves the resume self-correcting against a
    // redundant or out-of-order dispatch, just like play/pause.
    case 'resume':
      return { ...s, positionBase: positionAt(s, a.at), stalled: false, updatedAt: a.at }
  }
}
