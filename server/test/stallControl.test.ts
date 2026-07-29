import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initialState, positionAt, apply } from '../src/rooms/syncState.js'
import { attach, detach, forget, refresh, setBuffering, stallTiming, type StallRoom } from '../src/rooms/stallControl.js'

// Ojo con el `now` de cada llamada: mientras el enfriamiento vale 0 se pueden
// usar valores sintéticos (1_000, 10_000…), pero en cuanto el tope expira el
// módulo fija `cooldownUntil` con `Date.now()` real, así que a partir de ahí
// hay que pasarle también `Date.now()` o la comparación sale siempre falsa.
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
    expect(states).toBe(1) // ya estaba congelada: sin broadcast redundante
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
    expect(room.state.stalled).toBe(false) // el tope la sacó sola
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
    // Ana sigue cargando pero ya emitió su flanco y no emitirá otro: sin este
    // refresh explícito la sala no volvería a esperarla nunca.
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
    expect(room.state.stalled).toBe(true) // nadie lo tocó tras el detach
  })

  it('a seek mid-wait restarts the cap window instead of inheriting what was left of it', async () => {
    stallTiming.capMs = 300
    setBuffering(room, ana, true, 1_000)
    expect(room.state.stalled).toBe(true)

    await sleep(200)
    refresh(room, Date.now()) // reinicia la ventana: quedaban 100 ms, ahora vuelven a ser 300
    await sleep(200)
    expect(room.state.stalled).toBe(true) // el tope original (300 ms) ya habría expirado

    await sleep(200)
    expect(room.state.stalled).toBe(false) // el tope nuevo sí ha expirado
  })
})
