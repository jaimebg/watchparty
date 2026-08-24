import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initialState, positionAt, apply } from '../src/rooms/syncState.js'
import { attach, detach, forget, refresh, setBuffering, stallTiming, type StallRoom } from '../src/rooms/stallControl.js'

// Watch the `now` in each call: while the cooldown is 0 synthetic values work
// (1_000, 10_000, …), but the moment the cap expires the module sets
// `cooldownUntil` from the real `Date.now()`, so from then on it has to be
// passed `Date.now()` too or the comparison always comes out false.
const CAP = 60
const COOLDOWN = 120
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let room: StallRoom
let states: number
const ana = {}, luis = {}

beforeEach(() => {
  stallTiming.capMs = CAP
  stallTiming.cooldownMs = COOLDOWN
  states = 0
  room = { state: apply(initialState(0), { type: 'play', at: 0 }) }
  attach(room, () => { states++ })
})
afterEach(() => { detach(room); stallTiming.capMs = 20_000; stallTiming.cooldownMs = 10_000 })

describe('stallControl', () => {
  it('freezes the room while someone buffers and resumes when the last one is ready', () => {
    setBuffering(room, ana, true, 1_000)
    expect(room.state.stalled).toBe(true)
    expect(states).toBe(1)
    setBuffering(room, luis, true, 1_100)
    expect(states).toBe(1) // it was already frozen: no redundant broadcast
    setBuffering(room, ana, false, 1_200)
    expect(room.state.stalled).toBe(true) // Luis sigue cargando
    setBuffering(room, luis, false, 1_300)
    expect(room.state.stalled).toBe(false)
    expect(states).toBe(2)
  })

  it('a client that disconnects while buffering does not keep the room frozen', () => {
    setBuffering(room, ana, true, 1_000)
    expect(room.state.stalled).toBe(true)
    forget(room, ana, 1_100)
    expect(room.state.stalled).toBe(false)
  })

  it('resumes on its own once the cap expires, even with someone still buffering', async () => {
    setBuffering(room, ana, true, 1_000)
    expect(room.state.stalled).toBe(true)
    await sleep(CAP + 40)
    expect(room.state.stalled).toBe(false)
  })

  it('the cooldown after a forced resume stops an immediate re-freeze', async () => {
    setBuffering(room, ana, true, 1_000)
    await sleep(CAP + 40)
    expect(room.state.stalled).toBe(false) // the cap brought it out on its own
    setBuffering(room, ana, false, Date.now())
    setBuffering(room, ana, true, Date.now())
    expect(room.state.stalled).toBe(false) // sigue en enfriamiento
    await sleep(COOLDOWN)
    setBuffering(room, luis, true, Date.now())
    expect(room.state.stalled).toBe(true) // enfriamiento agotado
  })

  it('a seek clears the cooldown and re-freezes for the ones still buffering', async () => {
    setBuffering(room, ana, true, 1_000)
    await sleep(CAP + 40)
    expect(room.state.stalled).toBe(false)
    // Ana is still loading but has already emitted her edge and will not emit
    // another: without this explicit refresh the room would never wait for her
    // again.
    refresh(room, Date.now())
    expect(room.state.stalled).toBe(true)
  })

  it('the frozen position is the one the clock had when it stalled', () => {
    setBuffering(room, ana, true, 10_000)
    expect(positionAt(room.state, 90_000)).toBeCloseTo(10)
  })

  it('detach clears the pending cap timer so it cannot fire on a dead room', async () => {
    setBuffering(room, ana, true, 1_000)
    detach(room)
    await sleep(CAP + 40)
    expect(room.state.stalled).toBe(true) // nothing touched it after the detach
  })

  it('a seek mid-wait restarts the cap window instead of inheriting what was left of it', async () => {
    stallTiming.capMs = 300
    setBuffering(room, ana, true, 1_000)
    expect(room.state.stalled).toBe(true)

    await sleep(200)
    refresh(room, Date.now()) // restarts the window: 100 ms were left, now it is 300 again
    await sleep(200)
    expect(room.state.stalled).toBe(true) // the original cap (300 ms) would already have expired

    await sleep(200)
    expect(room.state.stalled).toBe(false) // the new cap has expired
  })
})
