import { apply, type PlaybackState } from './syncState.js'

// Wait cap and the cooldown after it runs out. Mutable on purpose: the tests
// lower them to milliseconds rather than sleep 20 s of wall clock.
export const stallTiming = { capMs: 20_000, cooldownMs: 10_000 }

// Only the state is needed: typing against the whole `Room` would tie this
// module to ffmpeg, subtitles and TMDB, and force the tests to build all of it.
export interface StallRoom { state: PlaybackState }

interface Entry {
  buffering: Set<object>
  timer: ReturnType<typeof setTimeout> | null
  cooldownUntil: number
  onState: () => void
}

const entries = new Map<StallRoom, Entry>()

export function attach(room: StallRoom, onState: () => void): void {
  // Re-registering without cleaning up would leave the previous entry's timer
  // alive, firing at `room.state` through a stale `onState`.
  detach(room)
  entries.set(room, { buffering: new Set(), timer: null, cooldownUntil: 0, onState })
}

export function detach(room: StallRoom): void {
  const e = entries.get(room)
  if (!e) return
  if (e.timer) clearTimeout(e.timer)
  entries.delete(room)
}

export function setBuffering(room: StallRoom, who: object, value: boolean, now: number): void {
  const e = entries.get(room)
  if (!e) return
  if (value) e.buffering.add(who)
  else e.buffering.delete(who)
  evaluate(room, e, now)
}

export function forget(room: StallRoom, who: object, now: number): void {
  const e = entries.get(room)
  if (!e) return
  e.buffering.delete(who)
  evaluate(room, e, now)
}

// For seek and play. An explicit user command deserves a fresh, full waiting
// window, and it also has to re-evaluate: if the cap has just expired, the
// straggler already emitted its `buffering:true` edge and is not going to emit
// another, so without this call the room would never wait for them again.
export function refresh(room: StallRoom, now: number): void {
  const e = entries.get(room)
  if (!e) return
  e.cooldownUntil = 0
  if (room.state.stalled) arm(room, e)
  evaluate(room, e, now)
}

function arm(room: StallRoom, e: Entry): void {
  if (e.timer) clearTimeout(e.timer)
  e.timer = setTimeout(() => {
    e.timer = null
    const now = Date.now()
    // The cooldown is the only thing stopping an immediate re-freeze: the
    // straggler is still in the Set and is not going to emit another edge.
    e.cooldownUntil = now + stallTiming.cooldownMs
    if (!room.state.stalled) return
    room.state = apply(room.state, { type: 'resume', at: now })
    e.onState()
  }, stallTiming.capMs)
  e.timer.unref?.()
}

function evaluate(room: StallRoom, e: Entry, now: number): void {
  const want = e.buffering.size > 0 && now >= e.cooldownUntil
  if (want === room.state.stalled) return
  room.state = apply(room.state, { type: want ? 'stall' : 'resume', at: now })
  if (want) arm(room, e)
  else if (e.timer) { clearTimeout(e.timer); e.timer = null }
  e.onState()
}
