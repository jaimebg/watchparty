import { apply, type PlaybackState } from './syncState.js'

// Tope de espera y enfriamiento tras agotarlo. Mutables a propósito: los tests
// los bajan a milisegundos para no dormir 20 s de reloj real.
export const stallTiming = { capMs: 20_000, cooldownMs: 10_000 }

// Solo se necesita el estado: tipar contra `Room` entero ataría este módulo a
// ffmpeg, subtítulos y TMDB, y obligaría a los tests a construir todo eso.
export interface StallRoom { state: PlaybackState }

interface Entry {
  buffering: Set<object>
  timer: ReturnType<typeof setTimeout> | null
  cooldownUntil: number
  onState: () => void
}

const entries = new Map<StallRoom, Entry>()

export function attach(room: StallRoom, onState: () => void): void {
  // Re-registrar sin limpiar dejaría vivo el timer de la entrada anterior,
  // disparando contra `room.state` a través de un `onState` obsoleto.
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

// Para seek y play. Una orden explícita del usuario merece una ventana de
// espera nueva y completa, y además hay que reevaluar: si el tope acaba de
// expirar, el rezagado ya emitió su flanco `buffering:true` y no va a emitir
// otro, así que sin esta llamada la sala no volvería a esperarlo jamás.
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
    // El enfriamiento es lo único que evita volver a congelar al instante: el
    // rezagado sigue en el Set y no va a emitir otro flanco.
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
