# Seek estable, código de sala y autoscroll del chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un seek deje de bloquear la sala en «cargando», que un invitado pueda entrar pegando el código de sala, y que el chat baje al fondo cuando llega un GIF.

**Architecture:** El reloj lógico de la sala gana un tercer estado, `stalled`, que congela la posición mientras algún espectador reporta que está cargando, con un tope de 20 s para que una conexión mala no secuestre la sesión. El cliente deja de forzar `currentTime` cada 500 ms (lo que tiraba el buffer que hls.js estaba llenando) y calcula su estado de carga a partir de `video.buffered` en vez de escuchar eventos que no disparan con el vídeo pausado. En el servidor, `init_*.mp4` se sirve desde un snapshot inmune a los reinicios de ffmpeg, y una petición de segmento muy por delante del punto de trabajo reinicia ffmpeg ahí en vez de agotar 30 s hasta el 504.

**Tech Stack:** TypeScript ESM en ambos workspaces. Server: Node ≥ 20, Fastify, `ws`, ffmpeg/ffprobe estáticos. Web: React 18 + Vite + hls.js. Tests: vitest (`npm test` en la raíz corre ambos workspaces).

**Spec:** `docs/superpowers/specs/2026-07-29-seek-estable-y-ux-design.md`

## Global Constraints

- Todo el código y los comentarios nuevos siguen el estilo del repo: comentarios en castellano o inglés según el archivo vecino, explicando **por qué**, nunca **qué**. No añadir comentarios triviales.
- `server/src/ws/messages.ts` y `web/src/types.ts` son **copias manuales** del mismo protocolo (no hay dependencia cruzada entre workspaces). Todo cambio de protocolo se aplica en ambos.
- Los imports del server llevan extensión `.js` (ESM compilado); los de `web` no llevan extensión.
- Los tests de `web` corren en entorno **node, sin DOM**. No escribir tests que monten componentes React.
- Verificación de tipos: `cd server && npx tsc --noEmit` y `cd web && npx tsc --noEmit`.
- Tests: `npm test` desde la raíz. Para un archivo suelto: `npx vitest run test/<archivo> --root server` (o `--root web`).
- Un commit por tarea, mensaje en inglés con prefijo convencional (`feat:`, `fix:`, `docs:`, `test:`), igual que el historial existente.

---

## File Structure

**Crear:**
- `server/src/rooms/stallControl.ts` — dueño único de la ventana de espera por sala: quién está cargando, el timer del tope y el enfriamiento. No sabe nada de sockets.
- `server/test/stallControl.test.ts` — tests unitarios del módulo anterior, sin sockets.
- `web/src/pages/roomToken.ts` — parseo puro de código/enlace de sala.
- `web/test/roomToken.test.ts`

**Modificar:**
- `server/src/rooms/syncState.ts` — campo `stalled`, acciones `stall`/`resume`.
- `server/src/ws/hub.ts` — cablea `stallControl`; sin lógica de decisión propia.
- `server/src/media/transcoder.ts` — `requestInit`, reinicio hacia delante, guarda en `seekTo`.
- `server/src/media/ffmpegArgs.ts` — solo si el test de timestamps lo exige (Task 7).
- `server/src/rooms/roomManager.ts` — `requestInit` en `SessionLike`; limpieza de snapshots en `retry`.
- `server/src/http/api.ts` — sirve el init vía `requestInit`.
- `web/src/types.ts` — espejo de `stalled`.
- `web/src/sync/driftControl.ts` — `bufferedAhead`, `targetPosition` con `stalled`.
- `web/src/player/Player.tsx` — bucle de deriva y señal de carga.
- `web/src/pages/Library.tsx` — formulario de código de sala.
- `web/src/chat/ChatPanel.tsx` — autoscroll por `ResizeObserver`.
- `web/src/theme.css` — wrapper `.chat-entries-inner`.
- `server/test/syncState.test.ts`, `server/test/hub.test.ts`, `server/test/api.test.ts`, `server/test/status.test.ts`, `server/test/transcoder.test.ts`, `web/test/driftControl.test.ts`
- `README.md`, `docs/e2e-checklist.md`

---

### Task 1: `stalled` en el estado de reproducción

Tercer estado del reloj: `paused` es intención del usuario, `stalled` es «el grupo espera al que carga». Ambos congelan la posición, pero solo `paused` cambia el botón de play.

**Files:**
- Modify: `server/src/rooms/syncState.ts`
- Modify: `web/src/types.ts:13-17`
- Modify: `web/src/sync/driftControl.ts:13-14`
- Test: `server/test/syncState.test.ts`, `web/test/driftControl.test.ts:19-27`

**Interfaces:**
- Consumes: nada.
- Produces: `PlaybackState { paused: boolean; positionBase: number; updatedAt: number; stalled: boolean }` y `SyncAction` con dos variantes nuevas `{ type: 'stall'; at: number }` y `{ type: 'resume'; at: number }` (server). Espejo idéntico del interfaz `PlaybackState` en `web/src/types.ts`.

- [ ] **Step 1: Escribir los tests que fallan**

Añadir a `server/test/syncState.test.ts`, dentro del `describe('syncState')` existente:

```ts
  it('stall freezes the clock where it was and resume restarts it from there', () => {
    let s = apply(initialState(0), { type: 'play', at: 0 })
    s = apply(s, { type: 'stall', at: 10_000 })
    expect(s.stalled).toBe(true)
    expect(s.paused).toBe(false)
    expect(positionAt(s, 60_000)).toBeCloseTo(10) // congelado aunque pase el tiempo
    s = apply(s, { type: 'resume', at: 60_000 })
    expect(s.stalled).toBe(false)
    expect(positionAt(s, 62_000)).toBeCloseTo(12) // sigue desde donde se congeló
  })

  it('play, pause and seek preserve the stalled flag', () => {
    let s = apply(apply(initialState(0), { type: 'play', at: 0 }), { type: 'stall', at: 1_000 })
    expect(apply(s, { type: 'pause', at: 2_000 }).stalled).toBe(true)
    expect(apply(s, { type: 'play', at: 2_000 }).stalled).toBe(true)
    expect(apply(s, { type: 'seek', position: 300, at: 2_000 }).stalled).toBe(true)
  })

  it('pausing while stalled keeps the frozen position, not the elapsed one', () => {
    let s = apply(apply(initialState(0), { type: 'play', at: 0 }), { type: 'stall', at: 5_000 })
    s = apply(s, { type: 'pause', at: 30_000 })
    expect(s.positionBase).toBeCloseTo(5) // no 30: el reloj estaba congelado
  })
```

Añadir a `web/test/driftControl.test.ts`, dentro del `describe('targetPosition')` existente:

```ts
  it('frozen when stalled even though it is not paused', () => {
    const state = { paused: false, positionBase: 100, updatedAt: 1000, stalled: true }
    expect(targetPosition(state, 1000, 5000, 99000)).toBe(100)
  })
```

Y añadir `stalled: false` a los dos literales de estado ya existentes en ese archivo (`web/test/driftControl.test.ts:21` y `:25`), que si no dejan de compilar.

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run test/syncState.test.ts --root server`
Expected: FAIL — `'stall'` no es un `SyncAction` válido (error de tipos) y `s.stalled` es `undefined`.

Run: `npx vitest run test/driftControl.test.ts --root web`
Expected: FAIL — `stalled` no existe en `PlaybackState`.

- [ ] **Step 3: Implementar en el servidor**

`server/src/rooms/syncState.ts` completo:

```ts
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
    // positionBase ya quedó congelado en el stall; solo hace falta reajustar
    // updatedAt para que el reloj cuente desde ahora y no desde entonces.
    case 'resume':
      return { ...s, stalled: false, updatedAt: a.at }
  }
}
```

- [ ] **Step 4: Implementar en el cliente**

En `web/src/types.ts`, añadir el campo al interfaz `PlaybackState`:

```ts
export interface PlaybackState {
  paused: boolean
  positionBase: number
  updatedAt: number
  stalled: boolean
}
```

En `web/src/sync/driftControl.ts`, sustituir la línea 13-14 por:

```ts
const positionAt = (s: PlaybackState, now: number) =>
  s.paused || s.stalled ? s.positionBase : s.positionBase + (now - s.updatedAt) / 1000
```

- [ ] **Step 5: Correr los tests y la verificación de tipos**

Run: `npx vitest run test/syncState.test.ts --root server && npx vitest run test/driftControl.test.ts --root web`
Expected: PASS

Run: `cd server && npx tsc --noEmit && cd ../web && npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add server/src/rooms/syncState.ts server/test/syncState.test.ts web/src/types.ts web/src/sync/driftControl.ts web/test/driftControl.test.ts
git commit -m "feat: add stalled flag to playback state so the room clock can freeze"
```

---

### Task 2: Módulo `stallControl`

Toda la decisión de cuándo congelar y cuándo reanudar, aislada de los sockets para poder testearla sin red y con tiempos de milisegundos.

**Files:**
- Create: `server/src/rooms/stallControl.ts`
- Test: `server/test/stallControl.test.ts`

**Interfaces:**
- Consumes: `PlaybackState`, `apply`, `initialState` de Task 1.
- Produces:
  - `stallTiming: { capMs: number; cooldownMs: number }` — mutable a propósito.
  - `interface StallRoom { state: PlaybackState }`
  - `attach(room: StallRoom, onState: () => void): void`
  - `detach(room: StallRoom): void`
  - `setBuffering(room: StallRoom, who: object, value: boolean, now: number): void`
  - `forget(room: StallRoom, who: object, now: number): void`
  - `refresh(room: StallRoom, now: number): void`

- [ ] **Step 1: Escribir el test que falla**

Crear `server/test/stallControl.test.ts`:

```ts
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
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/stallControl.test.ts --root server`
Expected: FAIL — `Cannot find module '../src/rooms/stallControl.js'`

- [ ] **Step 3: Implementar el módulo**

Crear `server/src/rooms/stallControl.ts`:

```ts
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
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run test/stallControl.test.ts --root server`
Expected: PASS (7 tests)

Run: `cd server && npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add server/src/rooms/stallControl.ts server/test/stallControl.test.ts
git commit -m "feat: stall control module — the room clock waits for buffering viewers, capped"
```

---

### Task 3: Cablear `stallControl` en el hub

**Files:**
- Modify: `server/src/ws/hub.ts`
- Test: `server/test/hub.test.ts`

**Interfaces:**
- Consumes: todo el API de Task 2.
- Produces: el mensaje `{t:'state', state, serverNow}` ya existente pasa a difundirse también cuando la sala se congela o se reanuda.

- [ ] **Step 1: Escribir el test que falla**

Añadir a `server/test/hub.test.ts` el import del módulo, junto a los que ya hay arriba:

```ts
import { stallTiming } from '../src/rooms/stallControl.js'
```

Y añadir estos tests dentro del `describe('hub')`:

```ts
  it('a buffering viewer freezes the room clock and the last ready one resumes it', async () => {
    // Sala propia: reusar una de otro test corre contra sus close handlers.
    const room = await rooms.create(items[0])
    const a = await connect('Iker', room.token)
    await a.recv(); await a.recv(); await a.recv() // welcome, presence, system
    const b = await connect('Sol', room.token)
    await b.recv() // welcome de Sol
    await a.recv(); await a.recv() // presence + system de Sol, en A
    await b.recv(); await b.recv() // presence + system, en B

    a.ws.send(JSON.stringify({ t: 'buffering', value: true }))
    const afterBuf = [await b.recv(), await b.recv()]
    expect(afterBuf.find(m => m.t === 'buffering')).toEqual({ t: 'buffering', name: 'Iker', value: true })
    expect(afterBuf.find(m => m.t === 'state')!.state.stalled).toBe(true)

    a.ws.send(JSON.stringify({ t: 'buffering', value: false }))
    const afterReady = [await b.recv(), await b.recv()]
    expect(afterReady.find(m => m.t === 'state')!.state.stalled).toBe(false)

    a.ws.close(); b.ws.close()
  })

  it('the room resumes on its own once the stall cap expires', async () => {
    const cap = stallTiming.capMs, cooldown = stallTiming.cooldownMs
    stallTiming.capMs = 150
    stallTiming.cooldownMs = 150
    try {
      const room = await rooms.create(items[0])
      const a = await connect('Noa', room.token)
      await a.recv(); await a.recv(); await a.recv() // welcome, presence, system

      a.ws.send(JSON.stringify({ t: 'buffering', value: true }))
      const frozen = [await a.recv(), await a.recv()]
      expect(frozen.find(m => m.t === 'state')!.state.stalled).toBe(true)

      // Nunca envía buffering:false: la sala debe salir sola por el tope.
      const resumed = await a.recv()
      expect(resumed.t).toBe('state')
      expect(resumed.state.stalled).toBe(false)

      a.ws.close()
    } finally {
      stallTiming.capMs = cap
      stallTiming.cooldownMs = cooldown
    }
  })
```

- [ ] **Step 2: Adaptar el test preexistente de desconexión**

El test «a disconnect while buffering broadcasts buffering:false so the indicator does not stick» (`server/test/hub.test.ts:168-186`) va a recibir un `state` extra tras cada `buffering`, y como `recv()` encola, ese mensaje sobrante descuadraría el siguiente `recv()`. Sustituir su cuerpo a partir del `a.ws.send`:

```ts
    a.ws.send(JSON.stringify({ t: 'buffering', value: true }))
    const onMsgs = [await b.recv(), await b.recv()] // buffering + state (la sala se congela)
    expect(onMsgs.find(m => m.t === 'buffering')).toEqual({ t: 'buffering', name: 'Pau', value: true })

    a.ws.close()
    const offMsgs = [await b.recv(), await b.recv()] // buffering + state (la sala se reanuda)
    expect(offMsgs.find(m => m.t === 'buffering')).toEqual({ t: 'buffering', name: 'Pau', value: false })

    b.ws.close()
```

Los demás tests de `hub.test.ts` no cambian: `stall.refresh` en `play`/`seek` no difunde nada cuando no hay nadie cargando.

- [ ] **Step 3: Correr los tests y verificar que fallan**

Run: `npx vitest run test/hub.test.ts --root server`
Expected: FAIL en los dos tests nuevos y en el adaptado — no llega ningún `state` tras el `buffering`, así que el segundo `recv()` agota el timeout de vitest.

- [ ] **Step 4: Cablear el hub**

En `server/src/ws/hub.ts`, añadir el import junto a los demás:

```ts
import * as stall from '../rooms/stallControl.js'
```

En `closeRoomSockets`, antes del `conns.delete(room)`:

```ts
  stall.detach(room)
  conns.delete(room)
```

En el bloque de enganches de una sola vez por sala (dentro de `if (!conns.has(room)) { … }`), tras `room.closeListeners.add(...)`:

```ts
      stall.attach(room, () => broadcast(room, { t: 'state', state: room.state, serverNow: Date.now() }))
```

En `case 'play': case 'pause':`, tras el `system(...)` y antes del `break`:

```ts
            if (msg.t === 'play') stall.refresh(room, now)
```

En `case 'seek':`, tras el `system(...)` y antes del `break`:

```ts
            stall.refresh(room, now)
```

En `case 'buffering':`, tras el `broadcast(...)` existente:

```ts
            stall.setBuffering(room, socket, msg.value, now)
```

En `socket.on('close', ...)`, **después** de la línea que difunde `buffering:false` y antes del broadcast de `presence`. El orden importa: el indicador «X está cargando…» debe apagarse antes de que llegue el cambio de reloj que provoca, que es lo que asume el test del Step 2.

```ts
      if (bufferingActive) broadcast(room, { t: 'buffering', name: me.name, value: false })
      stall.forget(room, socket, Date.now())
      broadcast(room, { t: 'presence', participants: [...peers.values()] })
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npx vitest run test/hub.test.ts --root server`
Expected: PASS — los dos nuevos, el adaptado y los seis preexistentes.

Run: `cd server && npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add server/src/ws/hub.ts server/test/hub.test.ts
git commit -m "feat: room clock waits for buffering viewers, with a 20s cap"
```

---

### Task 4: El cliente deja de pelearse con su propio buffer

Dos cambios que se necesitan mutuamente: la señal de carga pasa a calcularse desde `video.buffered` (el evento `playing` no dispararía nunca con el vídeo pausado por `stalled`, y la sala quedaría bloqueada hasta el tope), y las correcciones duras de `currentTime` se limitan a una cada 3 s.

**Files:**
- Modify: `web/src/sync/driftControl.ts`
- Modify: `web/src/player/Player.tsx:59-88`, `:104-121`
- Test: `web/test/driftControl.test.ts`

**Interfaces:**
- Consumes: `PlaybackState.stalled` de Task 1.
- Produces:
  - `interface Ranges { length: number; start(i: number): number; end(i: number): number }`
  - `bufferedAhead(ranges: Ranges, t: number): number`

- [ ] **Step 1: Escribir el test que falla**

Añadir a `web/test/driftControl.test.ts` (y ampliar el import de la primera línea a `computeCorrection, targetPosition, bufferedAhead`):

```ts
const ranges = (...pairs: [number, number][]) => ({
  length: pairs.length,
  start: (i: number) => pairs[i][0],
  end: (i: number) => pairs[i][1],
})

describe('bufferedAhead', () => {
  it('returns the contiguous seconds available from t', () => {
    expect(bufferedAhead(ranges([10, 25]), 12)).toBeCloseTo(13)
  })
  it('is 0 in a hole between ranges', () => {
    expect(bufferedAhead(ranges([0, 10], [30, 40]), 20)).toBe(0)
  })
  it('is 0 with nothing buffered', () => {
    expect(bufferedAhead(ranges(), 5)).toBe(0)
  })
  it('counts a t sitting exactly on the start edge', () => {
    expect(bufferedAhead(ranges([10, 25]), 10)).toBeCloseTo(15)
  })
  it('is 0 past the end edge', () => {
    expect(bufferedAhead(ranges([10, 25]), 25)).toBe(0)
  })
  it('picks the range that contains t, not the first one', () => {
    expect(bufferedAhead(ranges([0, 10], [30, 40]), 32)).toBeCloseTo(8)
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/driftControl.test.ts --root web`
Expected: FAIL — `bufferedAhead is not a function`.

- [ ] **Step 3: Implementar `bufferedAhead`**

Añadir al final de `web/src/sync/driftControl.ts`:

```ts
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
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run test/driftControl.test.ts --root web`
Expected: PASS

- [ ] **Step 5: Quitar los listeners `waiting`/`playing` del Player**

En `web/src/player/Player.tsx`, el efecto que empieza en la línea 59 pierde los listeners de buffering. Queda así:

```tsx
  useEffect(() => {
    const video = videoRef.current!

    let hls: Hls | null = null
    if (Hls.isSupported()) {
      hls = new Hls()
      hlsRef.current = hls
      hls.loadSource(`/stream/${token}/master.m3u8`)
      hls.attachMedia(video)
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () =>
        setAudioTracks(hls!.audioTracks.map((t, id) => ({ id, name: t.name }))))
      setMode('hls')
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = `/stream/${token}/master.m3u8`
      setMode('native')
    } else {
      setMode('unsupported')
    }

    return () => {
      if (hls) { hls.destroy(); hlsRef.current = null }
      else video.removeAttribute('src')
    }
  }, [token])
```

- [ ] **Step 6: Reescribir el bucle de deriva**

Ampliar el import de `driftControl` en la línea 4 a:

```tsx
import { bufferedAhead, computeCorrection, targetPosition } from '../sync/driftControl'
```

Añadir las constantes junto a `VOLUME_KEY`/`MUTED_KEY` (líneas 9-10):

```tsx
const READY_AHEAD_S = 2
const HARD_SEEK_MIN_INTERVAL_MS = 3000
```

Añadir los refs junto a los que ya existen (tras `sendRef.current = send`, línea 56):

```tsx
  const lastHardSeekRef = useRef(0)
  const bufferingRef = useRef(false)
  const infoRef = useRef(info)
  infoRef.current = info
```

Sustituir el efecto de las líneas 104-121 por:

```tsx
  // Un estado nuevo del servidor (seek, play/pausa, congelar/reanudar) desbloquea
  // una corrección inmediata: el límite de abajo solo debe frenar al bucle de
  // deriva, nunca a una orden explícita del usuario.
  useEffect(() => { lastHardSeekRef.current = 0 }, [lastState?.state.updatedAt])

  useEffect(() => {
    const id = setInterval(() => {
      const video = videoRef.current
      if (!video || !lastState) return
      const target = targetPosition(lastState.state, lastState.serverNow, lastState.receivedAt, Date.now())

      // La señal de carga se calcula, no se escucha: con el vídeo pausado porque
      // la sala está congelada, `playing` no dispararía nunca y la sala se
      // quedaría esperándonos hasta agotar el tope. Cerca del final nunca habrá
      // READY_AHEAD_S por delante, así que ese tramo cuenta siempre como listo.
      const nearEnd = target >= infoRef.current.durationSec - READY_AHEAD_S
      const starved = !nearEnd && bufferedAhead(video.buffered, target) < READY_AHEAD_S
      if (starved !== bufferingRef.current) {
        bufferingRef.current = starved
        sendRef.current({ t: 'buffering', value: starved })
      }

      // Cada corrección dura tira el buffer que hls.js está llenando. Sin este
      // límite, un hipo pasa a bloqueo permanente: se resiembra el buffer cada
      // 500 ms y nunca llega a haber suficiente para reproducir.
      const hardSeek = (to: number) => {
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) return
        if (Date.now() - lastHardSeekRef.current < HARD_SEEK_MIN_INTERVAL_MS) return
        lastHardSeekRef.current = Date.now()
        video.currentTime = to
      }

      if (lastState.state.paused || lastState.state.stalled) {
        if (!video.paused) video.pause()
        if (Math.abs(video.currentTime - target) > 0.5) hardSeek(target)
        return
      }
      if (video.paused) void video.play().catch(() => {})
      const c = computeCorrection(target, video.currentTime)
      if (c.kind === 'rate') video.playbackRate = c.rate
      else if (c.kind === 'seek') { hardSeek(c.to); video.playbackRate = 1 }
      else video.playbackRate = 1
    }, 500)
    return () => clearInterval(id)
  }, [lastState])
```

- [ ] **Step 7: Verificar tipos y build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: sin errores; el build produce `web/dist`.

Run: `npx vitest run --root web`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add web/src/sync/driftControl.ts web/src/player/Player.tsx web/test/driftControl.test.ts
git commit -m "fix: stop the drift loop from re-seeking over a starved buffer after a seek"
```

---

### Task 5: `init_*.mp4` estable

Cada reinicio de ffmpeg reescribe `init_%v.mp4`; un cliente que lo pida en ese instante recibe un archivo truncado y no puede decodificar nada, pero sí sigue pintando subtítulos. Se sirve desde un snapshot.

**Files:**
- Modify: `server/src/media/transcoder.ts`
- Modify: `server/src/rooms/roomManager.ts:14-21`, `:88-95`
- Modify: `server/src/http/api.ts:110-117`
- Test: `server/test/transcoder.test.ts`, `server/test/api.test.ts:14-19`, `:228-238`, `server/test/hub.test.ts:17-26`, `server/test/status.test.ts:14`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces: `TranscodeSession.requestInit(variant: number, timeoutMs?: number): Promise<string>`, añadido también a `SessionLike`.

- [ ] **Step 1: Escribir el test que falla**

Añadir a `server/test/transcoder.test.ts` (ampliando el import de `node:fs` a `mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync`):

```ts
  it('requestInit hands out a snapshot that survives ffmpeg rewriting the live init file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsc-init-'))
    const initOutDir = join(dir, 'out'); mkdirSync(initOutDir)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264',
      segments: session['segments'], audioCount: 2, outDir: initOutDir,
    })
    s.start()
    const p = await s.requestInit(0, 30_000)
    expect(p).toBe(join(initOutDir, 'init_0.stable.mp4'))
    const snapshot = readFileSync(p)
    expect(snapshot.length).toBeGreaterThan(0)

    // Simula el reinicio de ffmpeg dejando el init vivo a medio escribir: el
    // snapshot ya entregado no puede verse afectado.
    writeFileSync(join(initOutDir, 'init_0.mp4'), Buffer.alloc(3))
    expect(await s.requestInit(0, 5_000)).toBe(p)
    expect(readFileSync(p).equals(snapshot)).toBe(true)

    await s.stop()
  }, 60_000)
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/transcoder.test.ts --root server`
Expected: FAIL — `s.requestInit is not a function`.

- [ ] **Step 3: Implementar `requestInit`**

En `server/src/media/transcoder.ts`, ampliar el import de `node:fs`:

```ts
import { copyFileSync, existsSync, renameSync } from 'node:fs'
```

Añadir un campo privado junto a los demás:

```ts
  private initCopies = 0
```

Y el método, justo antes de `requestSegment`:

```ts
  // El init de fMP4 se reescribe entero en cada reinicio de ffmpeg. Un cliente
  // que lo descargue en ese instante se lleva un archivo truncado: el vídeo no
  // decodifica pero los <track> nativos siguen pintando subtítulos, que es
  // exactamente el síntoma reportado. Se entrega siempre una copia estable.
  async requestInit(variant: number, timeoutMs = 30_000): Promise<string> {
    const stable = join(this.opts.outDir, `init_${variant}.stable.mp4`)
    if (existsSync(stable)) return stable
    const live = join(this.opts.outDir, `init_${variant}.mp4`)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // El muxer HLS escribe y cierra el init antes de cerrar el primer
      // segmento, así que ver el segmento —que con temp_file solo aparece ya
      // completo— prueba que el init está entero.
      if (existsSync(live) && (this.finished || existsSync(this.segPath(variant, this.startSegment)))) {
        const tmp = `${stable}.${this.initCopies++}.tmp`
        copyFileSync(live, tmp)
        renameSync(tmp, stable)
        return stable
      }
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`Timeout esperando init v${variant}`)
  }
```

- [ ] **Step 4: Añadir `requestInit` a `SessionLike` y limpiar snapshots en `retry`**

En `server/src/rooms/roomManager.ts`, dentro de `interface SessionLike`, tras la línea de `requestSegment`:

```ts
  requestInit(variant: number, timeoutMs?: number): Promise<string>
```

Ampliar el import de `node:fs` a `import { mkdirSync, readdirSync, rmSync } from 'node:fs'` y, en `retry()`, tras `await room.session.stop()`:

```ts
    // Un snapshot de la ejecución rota no debe sobrevivir al reintento.
    for (const f of readdirSync(room.roomDir)) {
      if (f.endsWith('.stable.mp4')) rmSync(join(room.roomDir, f), { force: true })
    }
```

- [ ] **Step 5: Servir el init vía `requestInit`**

En `server/src/http/api.ts`, sustituir el bloque `const init = file.match(...)` completo (líneas 110-117) por:

```ts
    const init = file.match(/^init_(\d+)\.mp4$/)
    if (init) {
      const variant = Number(init[1])
      if (variant < 0 || variant > audioCount) return reply.code(404).send()
      try {
        const p = await room.session.requestInit(variant)
        return reply.type('video/mp4').send(createReadStream(p))
      } catch { return reply.code(504).send() }
    }
```

`isPathInside` deja de hacer falta aquí: la ruta ya no se construye a partir de `file`, sino del número de variante validado. `existsSync` sigue usándose en el bloque de subtítulos, así que el import no cambia.

- [ ] **Step 6: Actualizar los dobles de sesión de los tests**

`server/test/hub.test.ts`, dentro de `makeFakeSession()`, junto a `requestSegment`:

```ts
    requestInit: async () => '/dev/null',
```

`server/test/status.test.ts:14`, dentro del objeto de sesión falsa, junto a `requestSegment: async () => ''`:

```ts
requestInit: async () => '',
```

`server/test/api.test.ts`, en `fakeSession` (líneas 14-19), junto a `requestSegment`:

```ts
  requestInit: vi.fn(async () => { throw new Error('sin init') }),
```

Y en el test «404s (without leaking the filesystem path) for roomDir files missing on disk» (líneas 228-238), sustituir el bloque del init por:

```ts
    // El init ya no se busca en disco desde la ruta: se pide a la sesión, que
    // responde «todavía no» agotando el plazo. Eso es un 504 (no listo), no un
    // 404 (no existe); el 404 queda para variantes fuera de rango.
    const missingInit = await app.inject({ url: `/stream/${token}/init_0.mp4` })
    expect(missingInit.statusCode).toBe(504)
    expect(missingInit.body).not.toContain(process.env.JBG_DATA_DIR!)
```

- [ ] **Step 7: Correr toda la suite del server**

Run: `npx vitest run --root server`
Expected: PASS

Run: `cd server && npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 8: Commit**

```bash
git add server/src/media/transcoder.ts server/src/rooms/roomManager.ts server/src/http/api.ts server/test
git commit -m "fix: serve a stable init segment snapshot so ffmpeg restarts cannot truncate it"
```

---

### Task 6: Reinicio hacia delante y guarda en `seekTo`

**Files:**
- Modify: `server/src/media/transcoder.ts`
- Test: `server/test/transcoder.test.ts`

**Interfaces:**
- Consumes: `requestInit` de Task 5 (mismo archivo; sin dependencia de firma).
- Produces: sin API nueva; cambia el comportamiento de `requestSegment` y `seekTo`.

- [ ] **Step 1: Escribir los tests que fallan**

Añadir a `server/test/transcoder.test.ts`:

```ts
  it('seekTo to the segment the live process already started from does not restart it', async () => {
    // Vídeo y audio piden el mismo índice: si cada petición reiniciara ffmpeg,
    // se matarían entre sí en bucle y no se produciría nunca ese segmento.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-same-'))
    const sameOutDir = join(dir, 'out'); mkdirSync(sameOutDir)
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264', segments, audioCount: 2, outDir: sameOutDir,
    })
    s.start(mid)
    const proc = s['proc']
    expect(proc).not.toBeNull()

    s.seekTo(mid)
    expect(s['proc']).toBe(proc)

    await s.stop()
  }, 60_000)

  it('a segment far ahead of the working point restarts ffmpeg there instead of timing out', async () => {
    // Sin esto, el cliente espera los 30 s completos a un segmento que nadie
    // está produciendo y acaba en 504.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-fwd-'))
    const fwdOutDir = join(dir, 'out'); mkdirSync(fwdOutDir)
    const segments = session['segments']
    const late = segments.length - 1
    expect(late).toBeGreaterThan(1)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264', segments, audioCount: 2, outDir: fwdOutDir,
    })
    const seekSpy = vi.spyOn(s, 'seekTo')
    s.start(0)
    // Se mata el proceso a mano para que nadie avance hacia `late`: es la
    // situación real en la que ffmpeg quedó muy por detrás del reloj de sala.
    s['proc']?.kill('SIGKILL')
    await new Promise(r => setTimeout(r, 300))

    const p = await s.requestSegment(0, late, 45_000)
    expect(seekSpy).toHaveBeenCalledWith(late)
    expect(existsSync(p)).toBe(true)

    await s.stop()
  }, 90_000)
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npx vitest run test/transcoder.test.ts --root server`
Expected: FAIL — el primero porque `seekTo(mid)` reinicia el proceso (`s['proc']` cambia); el segundo por timeout, porque `seekTo` nunca se llama para un índice hacia delante.

- [ ] **Step 3: Implementar la guarda en `seekTo`**

En `server/src/media/transcoder.ts`, añadir al principio de `seekTo`, justo tras el `if (this.closed) return`:

```ts
    // Ya estamos produciendo desde ahí: matar el proceso que justo está llenando
    // ese hueco solo reiniciaría el trabajo desde cero. Sin esta guarda, las
    // peticiones de vídeo y de audio del mismo índice se matan entre sí en bucle.
    if (segmentIndex === this.startSegment && this.proc && this.proc.exitCode === null) return
```

- [ ] **Step 4: Implementar el reinicio hacia delante**

Añadir la constante arriba del archivo, junto a los imports:

```ts
const FORWARD_GRACE_MS = 6_000
```

Sustituir `requestSegment` por:

```ts
  async requestSegment(variant: number, index: number, timeoutMs = 30_000): Promise<string> {
    if (this.isReady(variant, index)) return this.segPath(variant, index)
    if (index < this.startSegment && !existsSync(this.segPath(variant, index))) this.seekTo(index)
    const deadline = Date.now() + timeoutMs
    const forwardAt = Date.now() + FORWARD_GRACE_MS
    let restarted = false
    while (Date.now() < deadline) {
      if (this.isReady(variant, index)) return this.segPath(variant, index)
      if (this.finished && existsSync(this.segPath(variant, index))) return this.segPath(variant, index)
      // Ni siquiera existe el segmento anterior: ffmpeg no viene de camino y
      // esperar el plazo entero solo acaba en 504. Se reinicia aquí, una vez.
      if (!restarted && Date.now() >= forwardAt && index > this.startSegment
          && !existsSync(this.segPath(variant, index - 1))) {
        restarted = true
        this.seekTo(index)
      }
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`Timeout esperando segmento v${variant}#${index}`)
  }
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npx vitest run test/transcoder.test.ts --root server`
Expected: PASS — incluidos los cuatro tests preexistentes de seek/caché/stop.

Run: `cd server && npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add server/src/media/transcoder.ts server/test/transcoder.test.ts
git commit -m "fix: restart ffmpeg at a segment far ahead of the working point instead of timing out"
```

---

### Task 7: Timestamps tras un arranque a mitad — medir y, si hace falta, corregir

`-output_ts_offset T` da por hecho que ffmpeg cae **exactamente** en el keyframe `T`. Si cae en el anterior, el medio declara empezar en `T` pero contiene desde antes, y el `tfdt` contradice la playlist. Esta tarea lo mide antes de tocar nada.

**Files:**
- Modify: `server/src/media/ffmpegArgs.ts` (solo si el test lo exige)
- Test: `server/test/transcoder.test.ts`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces: sin API nueva.

- [ ] **Step 1: Escribir el test de medición**

Añadir a `server/test/transcoder.test.ts` (ampliando los imports de `node:fs` con `readFileSync, writeFileSync` si no se añadieron en Task 5, y añadiendo arriba `import ffprobeStatic from 'ffprobe-static'` y `import { run } from './support/run.js'`):

```ts
  it('a segment produced by a mid-film start carries the correct absolute timestamp', async () => {
    // Si el tfdt del segmento no coincide con lo que dice la playlist, hls.js lo
    // bufferiza en el sitio equivocado: el vídeo no aparece pero los subtítulos,
    // que son <track> nativos guiados por currentTime, sí siguen pintándose.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-'))
    const tsOutDir = join(dir, 'out'); mkdirSync(tsOutDir)
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264', segments, audioCount: 2, outDir: tsOutDir,
    })
    s.start(mid)
    const segPath = await s.requestSegment(0, mid, 30_000)
    const initPath = await s.requestInit(0, 30_000)

    // Un fMP4 suelto no es reproducible: hay que anteponerle su init.
    const joined = join(dir, 'joined.mp4')
    writeFileSync(joined, Buffer.concat([readFileSync(initPath), readFileSync(segPath)]))
    const { stdout } = await run(ffprobeStatic.path, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=start_time', '-of', 'csv=p=0', joined,
    ])

    expect(Math.abs(Number(stdout.trim()) - segments[mid].start)).toBeLessThan(0.1)
    await s.stop()
  }, 90_000)
```

- [ ] **Step 2: Correr el test y anotar el resultado**

Run: `npx vitest run test/transcoder.test.ts --root server -t 'absolute timestamp'`

**Este paso decide la tarea. Anota el resultado y sigue la rama que corresponda:**

- **PASA** → `-output_ts_offset` es correcto en este entorno. No se toca `ffmpegArgs.ts`. Salta al Step 5 y en el mensaje de commit deja constancia de que el test queda como regresión.
- **FALLA** → sigue con los Steps 3 y 4.

- [ ] **Step 3: (solo si falló) Cambiar a `-copyts`**

En `server/src/media/ffmpegArgs.ts`, sustituir el bloque de `-output_ts_offset` (líneas 30-35, comentario incluido) por:

```ts
  // -ss antes de -i resetea los timestamps de salida a ~0. Reanclarlos con
  // -output_ts_offset asume que ffmpeg cayó exactamente en el keyframe pedido;
  // si cae en el anterior, el tfdt miente y hls.js bufferiza en el sitio
  // equivocado. -copyts no asume nada: conserva el tiempo absoluto de la fuente,
  // así que todos los reinicios comparten una única línea de tiempo global.
  if (seg.start > 0) args.push('-copyts')
```

Y en la rama de transcode, reanclar `-force_key_frames`, que da por hecho que `t` arranca en 0:

```ts
  if (x.mode === 'copy') args.push('-c:v', 'copy')
  else args.push('-c:v', x.encoder, ...(ENCODER_FLAGS[x.encoder] ?? []),
    // Con -copyts, `t` es absoluto: sin sumar el arranque, n_forced*4 iría muy
    // por detrás y forzaría un keyframe en cada fotograma. En modo transcode
    // planSegments reparte cada 4 s, así que seg.start siempre es múltiplo de 4.
    '-force_key_frames', `expr:gte(t,n_forced*4+${seg.start.toFixed(6)})`,
    '-pix_fmt', 'yuv420p')
```

En `server/test/ffmpegArgs.test.ts`, sustituir el test de las líneas 16-24 por:

```ts
  it('restart mid-stream keeps the source timeline with -copyts', () => {
    for (const mode of ['copy', 'transcode'] as const) {
      const a = buildTranscodeArgs({ ...base, mode, startSegment: 2 })
      const i = a.indexOf('-copyts')
      expect(i).toBeGreaterThan(a.indexOf('-i')) // opción de salida: tras el input
      expect(i).toBeLessThan(a.length - 1) // y antes de la URL de salida
    }
  })
```

En el test de las líneas 25-28, sustituir la aserción por:

```ts
    expect(a).not.toContain('-copyts')
```

Y en el de las líneas 29-37, la aserción de keyframes (el fixture usa `planSegments(20, null)`, así que `segments[2].start` es exactamente 8):

```ts
    expect(a.join(' ')).toContain('-force_key_frames expr:gte(t,n_forced*4+8.000000)')
```

Si el test de timestamps sigue fallando con `-copyts` a secas, la única variante a probar es añadir `'-avoid_negative_ts', 'disabled'` junto al `-copyts`. `-start_at_zero` queda descartado: deshace justo lo que se busca.

- [ ] **Step 4: (solo si falló) Correr los tests**

Run: `npx vitest run test/transcoder.test.ts test/ffmpegArgs.test.ts --root server`
Expected: PASS

- [ ] **Step 5: Correr toda la suite del server y commitear**

Run: `npx vitest run --root server`
Expected: PASS

```bash
git add server/test/transcoder.test.ts server/src/media/ffmpegArgs.ts server/test/ffmpegArgs.test.ts
git commit -m "test: assert mid-film restarts produce absolute segment timestamps"
```

(Si el Step 3 se ejecutó, usa `fix: use -copyts so every ffmpeg restart shares one timeline` como mensaje.)

---

### Task 8: Campo de código de sala en la portada del invitado

**Files:**
- Create: `web/src/pages/roomToken.ts`
- Create: `web/test/roomToken.test.ts`
- Modify: `web/src/pages/Library.tsx:67-84`

**Interfaces:**
- Consumes: nada.
- Produces: `parseRoomToken(input: string): string | null`

- [ ] **Step 1: Escribir el test que falla**

Crear `web/test/roomToken.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseRoomToken } from '../src/pages/roomToken'

const TOKEN = 'AbC123_xY-z9QwErTyUi'

describe('parseRoomToken', () => {
  it('accepts a bare token', () => {
    expect(parseRoomToken(TOKEN)).toBe(TOKEN)
  })
  it('trims surrounding whitespace', () => {
    expect(parseRoomToken(`  ${TOKEN}\n`)).toBe(TOKEN)
  })
  it('pulls the token out of a pasted room URL', () => {
    expect(parseRoomToken(`https://watchparty.example.com/room/${TOKEN}`)).toBe(TOKEN)
  })
  it('handles a trailing slash and a query string', () => {
    expect(parseRoomToken(`https://x.test/room/${TOKEN}/`)).toBe(TOKEN)
    expect(parseRoomToken(`https://x.test/room/${TOKEN}?foo=1`)).toBe(TOKEN)
  })
  it('rejects empty input', () => {
    expect(parseRoomToken('')).toBeNull()
    expect(parseRoomToken('   ')).toBeNull()
  })
  it('rejects arbitrary text and too-short tokens', () => {
    expect(parseRoomToken('no es un token')).toBeNull()
    expect(parseRoomToken('abc')).toBeNull()
  })
  it('rejects a URL that is not a room link', () => {
    expect(parseRoomToken('https://x.test/library')).toBeNull()
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/roomToken.test.ts --root web`
Expected: FAIL — `Cannot find module '../src/pages/roomToken'`

- [ ] **Step 3: Implementar el parseo**

Crear `web/src/pages/roomToken.ts`:

```ts
// Los tokens reales son 22 caracteres base64url (randomBytes(16) en
// server/src/rooms/roomManager.ts) y el enrutado de App.tsx acepta [\w-]+.
// El mínimo de 8 es solo un suelo de cordura para no navegar a basura.
const TOKEN_RE = /^[\w-]{8,}$/

// Acepta tanto el código pelado como un enlace de sala pegado entero, que es lo
// que el host comparte y lo que el invitado tiene a mano en el portapapeles.
export function parseRoomToken(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const fromUrl = trimmed.match(/\/room\/([\w-]+)/)
  const candidate = fromUrl ? fromUrl[1] : trimmed
  return TOKEN_RE.test(candidate) ? candidate : null
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run test/roomToken.test.ts --root web`
Expected: PASS

- [ ] **Step 5: Añadir el formulario a la portada del invitado**

En `web/src/pages/Library.tsx`, añadir el import:

```tsx
import { parseRoomToken } from './roomToken'
```

Añadir dos estados junto a los que ya existen (líneas 6-12):

```tsx
  const [roomInput, setRoomInput] = useState('')
  const [roomError, setRoomError] = useState<string | null>(null)
```

Y sustituir el bloque `if (guest) { … }` (líneas 67-84) por:

```tsx
  if (guest) {
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname)
    const enterRoom = () => {
      const token = parseRoomToken(roomInput)
      if (!token) { setRoomError('Eso no parece un código de sala. Pega el enlace completo o el código que va tras /room/.'); return }
      location.pathname = `/room/${token}`
    }
    return (
      <main className="page page--gate">
        <header className="masthead">
          <p className="eyebrow">JBG Watchparty</p>
          <h1>Función privada</h1>
          <div className="marquee-rule" aria-hidden="true" />
        </header>
        <p>Para ver la sesión necesitas el <strong>enlace de sala</strong> que comparte el host
          — termina en <code>/room/…</code>. Pídeselo y ábrelo tal cual.</p>
        <form className="name-form" onSubmit={e => { e.preventDefault(); enterRoom() }}>
          <input
            value={roomInput}
            onChange={e => { setRoomInput(e.target.value); setRoomError(null) }}
            placeholder="Código o enlace de la sala"
            aria-label="Código o enlace de la sala"
          />
          <button type="submit" className="btn-primary">Entrar</button>
        </form>
        {roomError && <p className="field-error">{roomError}</p>}
        {isLocal && (
          <p className="hint">¿Eres el host? Entra con la URL con <code>?key=…</code> que imprime la
            terminal al arrancar el servidor (se abre sola en el navegador).</p>
        )}
      </main>
    )
  }
```

- [ ] **Step 6: Verificar tipos, tests y build**

Run: `cd web && npx tsc --noEmit && npx vitest run && npm run build`
Expected: sin errores; tests PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/roomToken.ts web/test/roomToken.test.ts web/src/pages/Library.tsx
git commit -m "feat: let a guest enter a room by pasting its code or link"
```

---

### Task 9: Autoscroll del chat por altura

El efecto actual corre cuando llega la entrada, pero la `<img>` del GIF aún mide 0 px, así que `scrollHeight` es el de antes. Al cargar la imagen el contenido crece y ya nadie vuelve a desplazar. Observar la altura cubre GIF, mensaje multilínea y cambio de tamaño del panel con un solo mecanismo.

**Files:**
- Modify: `web/src/chat/ChatPanel.tsx:29-32`, `:52-70`
- Modify: `web/src/theme.css:914-926`

**Interfaces:**
- Consumes: nada.
- Produces: nada.

- [ ] **Step 1: Sustituir el efecto de scroll**

En `web/src/chat/ChatPanel.tsx`, añadir un ref junto a `entriesRef` (línea 17):

```tsx
  const entriesInnerRef = useRef<HTMLDivElement>(null)
```

Y sustituir el efecto de las líneas 29-32 por:

```tsx
  // Por altura y no por entrada nueva: cuando llega el mensaje, la <img> de un
  // GIF aún mide 0 px y scrollHeight es el de antes, así que la lista se queda
  // arriba en cuanto la imagen carga. Observar el contenido cubre de una vez el
  // GIF tardío, el mensaje multilínea y el cambio de tamaño del panel.
  useEffect(() => {
    const box = entriesRef.current
    const inner = entriesInnerRef.current
    if (!box || !inner) return
    const toBottom = () => { box.scrollTop = box.scrollHeight }
    const ro = new ResizeObserver(toBottom)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])
```

- [ ] **Step 2: Envolver las entradas**

Sustituir el bloque `<div className="chat-entries" ref={entriesRef}> … </div>` (líneas 52-70) por:

```tsx
      <div className="chat-entries" ref={entriesRef}>
        <div className="chat-entries-inner" ref={entriesInnerRef}>
          {state.entries.map(e => (
            <div key={e.id} className={`chat-entry chat-entry--${e.kind}`}>
              {e.kind === 'system' ? (
                <em>{e.text}</em>
              ) : e.kind === 'gif' ? (
                <>
                  <span style={{ color: e.from.color }}>{e.from.name}</span>
                  <img src={e.gifUrl ?? ''} alt="gif" />
                </>
              ) : (
                <>
                  <span style={{ color: e.from.color }}>{e.from.name}: </span>
                  {e.text}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
```

- [ ] **Step 3: Mover el flex al wrapper**

En `web/src/theme.css`, sustituir la regla `.chat-entries` (líneas 914-926) por estas dos. El contenedor externo conserva altura, scroll, bordes y padding, así que la regla de modo teatro de la línea 726 (`.room-grid--theater .chat-entries { max-height }`) sigue valiendo sin tocarla:

```css
.chat-entries {
  flex: 1;
  min-height: 240px;
  max-height: 50vh;
  overflow-y: auto;
  border-top: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
  padding: 0.6rem 0.1rem;
  overscroll-behavior: contain;
}

.chat-entries-inner {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
```

- [ ] **Step 4: Verificar tipos y build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add web/src/chat/ChatPanel.tsx web/src/theme.css
git commit -m "fix: keep chat scrolled to the bottom when a GIF finishes loading"
```

---

### Task 10: Verificación end-to-end y documentación

Los bloques del cliente no tienen test automatizado (los tests de `web` corren sin DOM), así que esta tarea es la que realmente valida el arreglo del seek.

**Files:**
- Modify: `README.md`
- Modify: `docs/e2e-checklist.md`

**Interfaces:**
- Consumes: todas las tareas anteriores.
- Produces: nada.

- [ ] **Step 1: Correr toda la suite y los dos chequeos de tipos**

Run: `npm test`
Expected: PASS en ambos workspaces.

Run: `cd server && npx tsc --noEmit && cd ../web && npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 2: Verificar a mano con dos navegadores**

`npm start`, crear sala, abrir la URL pública en un segundo navegador o dispositivo. Comprobar:

1. **Seek a mitad de peli:** ambas pantallas saltan; mientras cargan, el reloj de sala **no avanza** (el tiempo mostrado se queda quieto) y aparece «X está cargando…»; el vídeo arranca en las dos y sigue sincronizado. **Nunca** debe quedarse en subtítulos sobre negro.
2. **Seek hacia atrás a zona ya vista:** arranque casi instantáneo, sin reiniciar ffmpeg.
3. **Varios seeks seguidos y rápidos:** la sala sigue recuperándose; ninguna pantalla se queda bloqueada.
4. **Espectador lento:** con la red de un invitado estrangulada (DevTools → Network → throttling), la sala espera un máximo de ~20 s y luego sigue; no se queda congelada para siempre.
5. **Código de sala:** abrir la URL pública **sin** `/room/…`, pegar el enlace completo de sala en el campo nuevo → entra. Repetir pegando solo el código → entra. Escribir basura → error en línea, sin navegar.
6. **Autoscroll:** con el historial desplazado hacia arriba, enviar un GIF desde el otro navegador → la lista baja al fondo con el GIF ya visible. Repetir con un mensaje largo de varias líneas.

- [ ] **Step 3: Actualizar el README**

En la sección **Limitaciones en v1**, borrar esta línea, que este trabajo resuelve:

```
- **Pausa automática global** — si alguien se queda cargando, no se pausa automáticamente al resto
```

Y añadir a la lista de **Características** del principio del README (la que empieza con «🎬 Sincronización de reproducción en tiempo real»), tras esa primera línea:

```
- ⏳ La sala espera al espectador que se queda cargando (con tope de 20 s, para que una conexión mala no pare la sesión)
```

En **Troubleshooting → El vídeo no reproduce**, añadir:

```
- Si tras un salto la posición se queda quieta y aparece «X está cargando…», es el comportamiento esperado: la sala espera al rezagado hasta 20 s
```

- [ ] **Step 4: Actualizar el checklist E2E**

En `docs/e2e-checklist.md`, sección **Sync**, añadir tras la línea del seek hacia atrás:

```
- [ ] Durante la carga tras un seek, el reloj de sala se congela y no se desincroniza
- [ ] Invitado con red estrangulada → la sala espera como mucho ~20 s y luego sigue
```

Sección **Básico**, añadir:

```
- [ ] Abrir la URL pública sin /room/… y pegar el código de sala entra a la sala
```

Sección **Chat**, añadir:

```
- [ ] Con el historial desplazado hacia arriba, un GIF nuevo baja la lista al fondo
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/e2e-checklist.md
git commit -m "docs: document the buffering wait and add e2e checks for seek, room code and chat scroll"
```

---

## Notas para quien ejecute

- **El orden importa parcialmente.** Task 1 va primero (todo lo demás depende del tipo). Tasks 2–4 son la cadena del seek en el reloj; Tasks 5–7 son independientes de ellas y tocan solo el transcoder; Tasks 8 y 9 son independientes de todo. Task 10 va la última.
- **Task 7 tiene una rama condicional en el Step 2.** Ejecuta la medición y anota el resultado antes de decidir; no cambies `ffmpegArgs.ts` sin que el test lo pida.
- **Los tests del transcoder llaman a ffmpeg de verdad** y tardan; sus timeouts explícitos (60–90 s) son necesarios, no adornos.
- Si un test preexistente falla por recibir un mensaje `state` de más, no lo borres: pasa a recoger los mensajes en lote y buscarlos por `t`, que es el patrón que ya usan los tests de `hub.test.ts`.
