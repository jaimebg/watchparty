# Estado activo/ausente por visibilidad de pestaña — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar en la lista de participantes del chat quién tiene la pestaña de la sala visible (chip normal) y quién la tiene oculta/minimizada (chip atenuado), usando la Page Visibility API.

**Architecture:** El cliente escucha `visibilitychange` y envía `{t:'visibility', active}` por WebSocket. El servidor guarda `active` dentro de `Participant` y rebroadcastea `presence` con el roster completo (mismo patrón que join/leave; sin deltas). La UI solo lee `p.active` y atenúa el chip.

**Tech Stack:** Fastify 4 + `@fastify/websocket` (raw `ws`) en server; React 18 + Vite en web; Vitest en ambos workspaces. Spec: `docs/superpowers/specs/2026-07-29-presence-visibility-design.md`.

## Global Constraints

- Los tipos del protocolo viven en `server/src/ws/messages.ts` y tienen una **copia manual espejo** en `web/src/types.ts` — todo cambio de tipos se hace en AMBOS archivos, idéntico.
- Señal: Page Visibility API (`document.visibilityState`), NO focus/blur de window. Sin debounce.
- Sin mensajes de sistema en el chat por cambios de visibilidad (sería ruido).
- Copy de UI en español: el tooltip del chip ausente es `ausente`.
- Mensajes de commit en inglés, estilo del repo (`feat: …`, `test: …`).
- Comandos de test: `npm run test -w server -- hub` (un archivo), `npm run test -w server`, `npm run test -w web`, `npm run typecheck -w server`.

---

### Task 1: Servidor — `active` en `Participant` + mensaje `visibility`

**Files:**
- Modify: `server/src/ws/messages.ts` (líneas 3 y 6-12)
- Modify: `server/src/ws/hub.ts` (líneas 28-33, 77-85, 88-131)
- Test: `server/test/hub.test.ts`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces: `Participant { id: string; name: string; color: string; active: boolean }`; mensaje de cliente `{ t: 'visibility'; active: boolean }` que actualiza `active` del emisor y difunde `{ t: 'presence', participants: Participant[] }` (roster completo). `active` nace `true` en el join. Las tareas 2 y 3 dependen de estas formas exactas.

- [ ] **Step 1: Escribir el test que falla**

Agregar al final del `describe('hub', …)` en `server/test/hub.test.ts` (el helper `connect` y `rooms`/`items` ya existen en ese archivo):

```ts
it('a visibility message updates the participant and rebroadcasts full presence', async () => {
  // Sala propia para no correr contra los close handlers de tests anteriores
  // (mismo motivo que el test de seek clamp).
  const room = await rooms.create(items[0])
  const a = await connect('Vera', room.token)
  const wA = await a.recv()
  expect(wA.t).toBe('welcome')
  expect(wA.self.active).toBe(true)
  await a.recv(); await a.recv() // presence propio + system "se unió"
  const b = await connect('Beto', room.token)
  const wB = await b.recv() // welcome de Beto
  expect(wB.participants.every((p: any) => p.active === true)).toBe(true)
  await a.recv(); await a.recv() // presence + system de Beto, en A
  await b.recv(); await b.recv() // presence + system, en B

  a.ws.send(JSON.stringify({ t: 'visibility', active: false }))
  const presB = await b.recv()
  expect(presB.t).toBe('presence')
  expect(presB.participants.find((p: any) => p.name === 'Vera').active).toBe(false)
  expect(presB.participants.find((p: any) => p.name === 'Beto').active).toBe(true)

  // Un payload malformado se ignora en silencio; el siguiente válido sí llega.
  a.ws.send(JSON.stringify({ t: 'visibility', active: 'x' }))
  a.ws.send(JSON.stringify({ t: 'visibility', active: true }))
  const presB2 = await b.recv()
  expect(presB2.t).toBe('presence')
  expect(presB2.participants.find((p: any) => p.name === 'Vera').active).toBe(true)

  a.ws.close(); b.ws.close()
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm run test -w server -- hub`
Expected: FAIL en el nuevo test con `expected undefined to be true` (en `wA.self.active`). Los 6 tests previos de hub siguen en verde.

- [ ] **Step 3: Implementación mínima**

En `server/src/ws/messages.ts`, línea 3, agregar `active`:

```ts
export interface Participant { id: string; name: string; color: string; active: boolean }
```

y en el union `ClientMsg` (después de la variante `buffering`):

```ts
  | { t: 'visibility'; active: boolean }
```

En `server/src/ws/hub.ts`:

1. En `system()` (línea 29), el participante sintético cumple el tipo nuevo:

```ts
const entry: ChatEntry = { id: randomBytes(6).toString('hex'), from: { id: 'sys', name: 'sistema', color: '#888', active: true }, kind: 'system', text, at: Date.now() }
```

2. En el join (línea 79), nacer activo:

```ts
me = { id: randomBytes(6).toString('hex'), name: msg.name.slice(0, 30) || 'Anónimo', color: COLORS[peers.size % COLORS.length], active: true }
```

3. Nuevo case en el `switch` (después de `case 'buffering'`, mismo estilo de validación campo a campo):

```ts
case 'visibility': {
  if (typeof msg.active !== 'boolean') return
  me.active = msg.active
  broadcast(room, { t: 'presence', participants: [...peers.values()] })
  break
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `npm run test -w server -- hub`
Expected: PASS (7 tests).

Run: `npm run typecheck -w server`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add server/src/ws/messages.ts server/src/ws/hub.ts server/test/hub.test.ts
git commit -m "feat: track participant active state via visibility message"
```

---

### Task 2: Web — espejo de tipos + envío de visibilidad

**Files:**
- Modify: `web/src/types.ts` (líneas 20 y 23-29)
- Modify: `web/src/ws.ts` (línea 13)
- Modify: `web/src/pages/Room.tsx` (nuevo efecto junto a los existentes, ~línea 65)
- Modify: `web/test/chatStore.test.ts` (línea 4, fixture)

**Interfaces:**
- Consumes: de Task 1, `Participant.active: boolean` y el mensaje `{ t: 'visibility'; active: boolean }`.
- Produces: el cliente envía `{ t: 'visibility', active: document.visibilityState === 'visible' }` en cada `visibilitychange`, y `{ t: 'visibility', active: false }` justo tras el `join` si la pestaña ya estaba oculta al (re)conectar. Task 3 depende de que `state.participants[i].active` llegue poblado al `ChatPanel`.

- [ ] **Step 1: Actualizar el espejo de tipos**

En `web/src/types.ts`, línea 20 (idéntico al server):

```ts
export interface Participant { id: string; name: string; color: string; active: boolean }
```

y en el union `ClientMsg` (después de la variante `buffering`):

```ts
  | { t: 'visibility'; active: boolean }
```

- [ ] **Step 2: Actualizar el fixture del test del reducer**

En `web/test/chatStore.test.ts`, línea 4, mantener el fixture representativo del tipo nuevo:

```ts
const p = { id: 'u1', name: 'Ana', color: '#f00', active: true }
```

(No hay asserts nuevos: el reducer reemplaza `participants` tal cual llega; el spec lo deja explícitamente sin cambios.)

- [ ] **Step 3: Enviar visibilidad al (re)conectar**

En `web/src/ws.ts`, el `onopen` (línea 13) pasa a avisar si la pestaña ya estaba oculta al conectar — cubre tanto la conexión inicial como cada reconexión del backoff, donde el server crea un participante nuevo con `active: true`:

```ts
ws.onopen = () => {
  attempt = 0
  ws!.send(JSON.stringify({ t: 'join', name }))
  // El server nos crea con active:true; si la pestaña ya estaba oculta al
  // (re)conectar, corregimos de inmediato. Si está visible no hay nada que
  // corregir (y se evita un broadcast de presence redundante por join).
  if (document.visibilityState === 'hidden') ws!.send(JSON.stringify({ t: 'visibility', active: false }))
}
```

- [ ] **Step 4: Listener de `visibilitychange` en Room**

En `web/src/pages/Room.tsx`, agregar este efecto después del efecto del socket (tras la línea 63). `sendRef` ya existe (línea 36) y `connectRoom` descarta envíos con el socket cerrado, así que no hace falta guard adicional:

```tsx
// Presencia: avisa cuando la pestaña pasa a segundo plano o vuelve (Page
// Visibility API; ver spec 2026-07-29-presence-visibility-design.md).
useEffect(() => {
  const onVis = () => sendRef.current({ t: 'visibility', active: document.visibilityState === 'visible' })
  document.addEventListener('visibilitychange', onVis)
  return () => document.removeEventListener('visibilitychange', onVis)
}, [])
```

- [ ] **Step 5: Verificar**

Run: `npm run test -w web`
Expected: PASS (los tests existentes; no hay tests nuevos — no hay entorno DOM en el harness web y el comportamiento observable del server ya quedó cubierto en Task 1).

Run: `npm run build -w web`
Expected: build de Vite sin errores.

- [ ] **Step 6: Commit**

```bash
git add web/src/types.ts web/src/ws.ts web/src/pages/Room.tsx web/test/chatStore.test.ts
git commit -m "feat: send tab visibility to server on change and reconnect"
```

---

### Task 3: UI — chip atenuado para ausentes

**Files:**
- Modify: `web/src/chat/ChatPanel.tsx` (líneas 43-50)
- Modify: `web/src/theme.css` (líneas 499-504)

**Interfaces:**
- Consumes: de Task 1/2, `p.active: boolean` en cada elemento de `state.participants`.
- Produces: nada para tareas posteriores (tarea final).

- [ ] **Step 1: Clase `away` + tooltip en el chip**

En `web/src/chat/ChatPanel.tsx`, el `<li>` de la lista de participantes (línea 45) pasa a:

```tsx
<li key={p.id} className={p.active ? undefined : 'away'} title={p.active ? undefined : 'ausente'}>
  <span className="dot" style={{ background: p.color }} />
  {p.name}
</li>
```

- [ ] **Step 2: Estilos**

En `web/src/theme.css`, la regla `.participants li` (línea 499) gana la transición, y se agrega la regla `away` a continuación:

```css
.participants li {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.85rem;
  transition: opacity 0.3s ease;
}

.participants li.away {
  opacity: 0.45;
}
```

- [ ] **Step 3: Verificar**

Run: `npm run test -w web && npm run build -w web`
Expected: PASS / build sin errores.

Verificación manual (opcional pero recomendada): `npm start`, abrir una sala en dos pestañas con nombres distintos, cambiar una pestaña a segundo plano → en la otra, su chip se atenúa con `title="ausente"`; volver → recupera opacidad.

- [ ] **Step 4: Commit**

```bash
git add web/src/chat/ChatPanel.tsx web/src/theme.css
git commit -m "feat: dim participant chip when tab is hidden"
```

---

### Task 4: Verificación final

- [ ] **Step 1: Suite completa**

Run: `npm test` (raíz: server + web) y `npm run typecheck -w server`
Expected: todo en verde.

- [ ] **Step 2: Marcar el spec como implementado**

Ningún cambio de docs pendiente: el spec ya está commiteado y este plan queda como registro. No hay README que actualizar (la feature no toca config ni setup).
