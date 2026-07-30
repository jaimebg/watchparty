# Destello de reacciones, emojis personalizables y pantalla completa — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la lista de participantes destelle el emoji que acaba de mandar cada persona, que cada espectador elija cualquier emoji para su barra de accesos rápidos desde un modal propio, y que el vídeo se pueda poner a pantalla completa con el chat flotando abajo a la derecha.

**Architecture:** Tres bloques independientes que se implementan en orden porque el tercero depende del CSS del segundo. (1) El servidor pasa a identificar las reacciones por `fromId` en vez de por nombre, y `chatStore` guarda un mapa `flashes` por participante que caduca vía `animationend`, igual que ya hace el overlay. (2) Un catálogo de emojis en español generado a mano y commiteado como módulo `.ts`, con lógica de búsqueda y de lista rápida en funciones puras testeables, más un modal que concentra toda la gestión. (3) Pantalla completa **solo con CSS** sobre `.room-grid` —que ya contiene vídeo y chat—, de modo que el árbol de React no cambia y el `ChatPanel` nunca se desmonta.

**Tech Stack:** TypeScript, React 18, Vite 5, Vitest 2 (entorno node), Fastify + `ws` en el servidor, CSS a mano en `web/src/theme.css`.

## Global Constraints

- **Spec de referencia:** `docs/superpowers/specs/2026-07-30-reacciones-emojis-y-pantalla-completa-design.md`.
- **Commits directos a `main`.** No se crean ramas en este repo.
- **Vitest corre en entorno node** (`web/vitest.config.ts` es `test: {}`): no hay `localStorage`, `window` ni `document` en los tests. Toda lógica que se pruebe debe ser pura; el acceso a `localStorage` vive en los componentes.
- **No añadir dependencias** a `web/package.json` ni a `server/package.json`.
- **Idioma:** todo el texto de interfaz y los comentarios de código, en español, como el resto del repo.
- **Comentarios:** solo donde expliquen *por qué*, no *qué*. Es la norma del repositorio; no comentar lo evidente.
- **`web/src/types.ts` es una copia manual** de `server/src/ws/messages.ts`. Cualquier cambio en el protocolo se aplica **en los dos**.
- **Tope de accesos rápidos:** `MAX_QUICK = 12`. **Duración del destello:** 2,5 s. **Inactividad antes de ocultar el chrome:** 3000 ms.
- **Verificación de tipos:** `npx tsc --noEmit` dentro de `server/` y dentro de `web/`. Debe pasar limpio.
- **Tests completos:** `npm test` en la raíz corre server y web.

---

## Estructura de ficheros

**Se crean:**

| Fichero | Responsabilidad |
|---|---|
| `web/src/chat/quickEmojis.ts` | Constantes y funciones puras de la lista de accesos rápidos. Sin `localStorage`. |
| `web/src/chat/emojiSearch.ts` | Tipo `EmojiRow`, categorías, normalización y búsqueda. Sin datos. |
| `web/src/chat/emojiCatalog.ts` | **Generado.** Solo datos: 1.906 filas `[unicode, etiqueta, tags, grupo]`. |
| `web/scripts/gen-emoji-catalog.mjs` | Regenera el fichero de arriba. Se ejecuta a mano. |
| `web/src/chat/EmojiPicker.tsx` | El modal: chips actuales, buscador, pestañas y rejilla. |
| `web/src/player/useFullscreen.ts` | Pantalla completa nativa con respaldo «modo cine». |
| `web/src/player/useIdleChrome.ts` | Auto-ocultado del chrome tras inactividad. |
| `web/test/quickEmojis.test.ts` | Tests de la lista rápida. |
| `web/test/emojiSearch.test.ts` | Tests de búsqueda + cordura del catálogo generado. |

**Se modifican:**

| Fichero | Cambio |
|---|---|
| `server/src/ws/messages.ts` | `reaction` lleva `fromId` en vez de `from`. |
| `server/src/ws/hub.ts` | Difunde `fromId: me.id`. |
| `server/test/hub.test.ts` | Aserción de la reacción. |
| `web/src/types.ts` | Espejo del cambio de protocolo. |
| `web/src/chat/chatStore.ts` | `flashes`, poda en `presence`, reset en `welcome`, `dropFlash`. |
| `web/test/chatStore.test.ts` | Tests de destellos. |
| `web/src/chat/ChatPanel.tsx` | Pinta el destello en el chip. |
| `web/src/chat/ReactionsBar.tsx` | Lista persistida + botón `+`. |
| `web/src/pages/Room.tsx` | Acción `drop-flash`, `useFullscreen`, `useIdleChrome`, clases del grid. |
| `web/src/player/Player.tsx` | Botón de pantalla completa, doble clic, tecla `F`. |
| `web/src/player/format.ts` | `isTypingTarget`. |
| `web/test/format.test.ts` | Tests de `isTypingTarget`. |
| `web/src/theme.css` | Destello, modal de emojis, bloque de pantalla completa. |
| `docs/e2e-checklist.md` | Casos manuales de navegador. |
| `README.md` | Reacciones personalizables, pantalla completa, script generador. |

---

## Task 1: El servidor identifica la reacción por `fromId`

Hoy la reacción viaja con el **nombre** del participante. Dos invitados pueden entrar con el mismo nombre, así que el destello del Task 3 caería en el chip equivocado. `Participant.id` ya es único y se genera en el `join`.

**Files:**
- Modify: `server/src/ws/messages.ts:20`
- Modify: `server/src/ws/hub.ts:125-129`
- Modify: `web/src/types.ts:38`
- Test: `server/test/hub.test.ts:82-85`

**Interfaces:**
- Consumes: nada.
- Produces: `ServerMsg` variante `{ t: 'reaction'; emoji: string; fromId: string }`, donde `fromId` es `Participant.id`. Lo consumen los Tasks 2 y 3.

- [ ] **Step 1: Cambiar la aserción del test para que falle**

En `server/test/hub.test.ts`, sustituye la línea 84 por:

```ts
    expect(rB).toMatchObject({ t: 'reaction', emoji: '🔥' })
    expect(typeof rB.fromId).toBe('string')
    expect(rB.fromId).toBe(wA.self.id)
    expect(rB).not.toHaveProperty('from')
```

`wA` es el `welcome` de Ana, ya capturado en la línea 60 de ese mismo test, así que `wA.self.id` es exactamente el id que el servidor debe mandar.

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -w server -- hub`
Expected: FAIL en `expect(rB.fromId).toBe(wA.self.id)` — `rB.fromId` es `undefined` y el mensaje todavía trae `from: 'Ana'`.

- [ ] **Step 3: Cambiar el tipo en el servidor**

En `server/src/ws/messages.ts`, línea 20, sustituye:

```ts
  | { t: 'reaction'; emoji: string; from: string }
```

por:

```ts
  | { t: 'reaction'; emoji: string; fromId: string }
```

- [ ] **Step 4: Cambiar el broadcast**

En `server/src/ws/hub.ts`, dentro de `case 'reaction'` (línea 127), sustituye:

```ts
            broadcast(room, { t: 'reaction', emoji: msg.emoji.slice(0, 8), from: me.name })
```

por:

```ts
            broadcast(room, { t: 'reaction', emoji: msg.emoji.slice(0, 8), fromId: me.id })
```

La validación `if (typeof msg.emoji !== 'string') return` y el recorte a 8 caracteres se quedan tal cual.

- [ ] **Step 5: Reflejar el cambio en el espejo del cliente**

En `web/src/types.ts`, línea 38, sustituye:

```ts
  | { t: 'reaction'; emoji: string; from: string }
```

por:

```ts
  | { t: 'reaction'; emoji: string; fromId: string }
```

- [ ] **Step 6: Correr el test y verificar que pasa**

Run: `npm test -w server -- hub`
Expected: PASS.

- [ ] **Step 7: Verificar tipos en los dos paquetes**

Run: `cd server && npx tsc --noEmit && cd ../web && npx tsc --noEmit && cd ..`
Expected: sin salida. Si `web` se queja, es que algún sitio leía `m.from` — busca con `grep -rn "\.from\b" web/src` y arréglalo.

- [ ] **Step 8: Commit**

```bash
git add server/src/ws/messages.ts server/src/ws/hub.ts server/test/hub.test.ts web/src/types.ts
git commit -m "refactor: la reacción viaja con fromId en vez de con el nombre"
```

---

## Task 2: `chatStore` guarda un destello por participante

**Files:**
- Modify: `web/src/chat/chatStore.ts`
- Test: `web/test/chatStore.test.ts`

**Interfaces:**
- Consumes: `ServerMsg` con `fromId` (Task 1).
- Produces:
  - `interface ReactionFlash { id: number; emoji: string }`
  - `ChatState.flashes: Record<string, ReactionFlash>` (clave = `Participant.id`)
  - `dropFlash(s: ChatState, pid: string, id: number): ChatState`

  Los usan el Task 3 (`ChatPanel`, `Room`).

- [ ] **Step 1: Escribir los tests que fallan**

Añade a `web/test/chatStore.test.ts`, dentro del `describe('chatReducer')` y después del test de reacciones existente:

```ts
  it('la reacción deja un destello indexado por participante', () => {
    const s = chatReducer(initialChat, { t: 'reaction', emoji: '🔥', fromId: 'u1' } as any)
    expect(s.flashes).toEqual({ u1: { id: 1, emoji: '🔥' } })
    // Overlay y destello comparten el mismo id.
    expect(s.reactions).toEqual([{ id: 1, emoji: '🔥' }])
  })

  it('un destello nuevo del mismo participante reemplaza al anterior', () => {
    let s = chatReducer(initialChat, { t: 'reaction', emoji: '🔥', fromId: 'u1' } as any)
    s = chatReducer(s, { t: 'reaction', emoji: '😂', fromId: 'u1' } as any)
    expect(s.flashes).toEqual({ u1: { id: 2, emoji: '😂' } })
  })

  it('dropFlash con un id caducado no borra el destello nuevo', () => {
    let s = chatReducer(initialChat, { t: 'reaction', emoji: '🔥', fromId: 'u1' } as any)
    s = chatReducer(s, { t: 'reaction', emoji: '😂', fromId: 'u1' } as any)
    // Llega tarde el animationend del primer destello.
    expect(dropFlash(s, 'u1', 1).flashes).toEqual({ u1: { id: 2, emoji: '😂' } })
    expect(dropFlash(s, 'u1', 2).flashes).toEqual({})
  })

  it('welcome limpia los destellos', () => {
    let s = chatReducer(initialChat, { t: 'reaction', emoji: '🔥', fromId: 'u1' } as any)
    s = chatReducer(s, { t: 'welcome', self: p, participants: [p], state: { paused: true, positionBase: 0, updatedAt: 0 }, serverNow: 0, history: [] } as any)
    expect(s.flashes).toEqual({})
  })

  it('presence poda el destello de quien ya no está y conserva el de quien sí', () => {
    let s = chatReducer(initialChat, { t: 'reaction', emoji: '🔥', fromId: 'u1' } as any)
    s = chatReducer(s, { t: 'reaction', emoji: '😂', fromId: 'u2' } as any)
    s = chatReducer(s, { t: 'presence', participants: [p] } as any)
    expect(s.flashes).toEqual({ u1: { id: 1, emoji: '🔥' } })
  })
```

`p` ya existe en la cabecera del fichero con `id: 'u1'`. Amplía el import de la línea 2 para incluir `dropFlash`:

```ts
import { chatReducer, initialChat, dropFlash, dropReaction, resetReactionIds, type ChatState } from '../src/chat/chatStore'
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npm test -w web -- chatStore`
Expected: FAIL — `dropFlash` no existe (error de importación) y `s.flashes` es `undefined`.

- [ ] **Step 3: Implementar el estado y las transiciones**

Sustituye el contenido completo de `web/src/chat/chatStore.ts` por:

```ts
import type { ChatEntry, Participant, ServerMsg } from '../types'

export interface ReactionFlash { id: number; emoji: string }

export interface ChatState {
  entries: ChatEntry[]; participants: Participant[]
  buffering: string[]; reactions: { id: number; emoji: string }[]
  // Último emoji de cada participante, indexado por su id (no por nombre: dos
  // invitados pueden llamarse igual). Caduca solo, por animationend.
  flashes: Record<string, ReactionFlash>
}

export const initialChat: ChatState = { entries: [], participants: [], buffering: [], reactions: [], flashes: {} }
let reactionId = 0

export function resetReactionIds(): void {
  reactionId = 0
}

// Quien reacciona y se marcha acto seguido deja su chip fuera del DOM, así que
// su animationend no llega nunca y su destello se quedaría colgado.
function pruneFlashes(flashes: Record<string, ReactionFlash>, participants: Participant[]): Record<string, ReactionFlash> {
  const live = new Set(participants.map(p => p.id))
  const next: Record<string, ReactionFlash> = {}
  for (const pid of Object.keys(flashes)) if (live.has(pid)) next[pid] = flashes[pid]
  return next
}

export function chatReducer(s: ChatState, m: ServerMsg): ChatState {
  switch (m.t) {
    // Reset buffering too: a `buffering:false` broadcast missed while
    // disconnected would otherwise leave a stale "X está cargando…" forever,
    // since welcome is the only signal that we're rejoining from scratch.
    // Los destellos se reinician por lo mismo: una pestaña en segundo plano no
    // ejecuta animaciones, así que uno podría sobrevivir a la reconexión.
    case 'welcome': return { ...s, entries: m.history, participants: m.participants, buffering: [], flashes: {} }
    case 'chat': return { ...s, entries: [...s.entries, m.entry].slice(-500) }
    case 'presence': return { ...s, participants: m.participants, flashes: pruneFlashes(s.flashes, m.participants) }
    case 'buffering': return { ...s, buffering: m.value ? [...new Set([...s.buffering, m.name])] : s.buffering.filter(n => n !== m.name) }
    case 'reaction': {
      const id = ++reactionId
      return {
        ...s,
        reactions: [...s.reactions, { id, emoji: m.emoji }],
        flashes: { ...s.flashes, [m.fromId]: { id, emoji: m.emoji } },
      }
    }
    default: return s
  }
}

export const dropReaction = (s: ChatState, id: number): ChatState =>
  ({ ...s, reactions: s.reactions.filter(r => r.id !== id) })

// Solo retira si el id coincide: si esa persona ha vuelto a reaccionar mientras
// tanto, el animationend del destello viejo no debe llevarse por delante al nuevo.
export const dropFlash = (s: ChatState, pid: string, id: number): ChatState => {
  if (s.flashes[pid]?.id !== id) return s
  const next = { ...s.flashes }
  delete next[pid]
  return { ...s, flashes: next }
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npm test -w web -- chatStore`
Expected: PASS, incluidos los tests que ya existían.

- [ ] **Step 5: Commit**

```bash
git add web/src/chat/chatStore.ts web/test/chatStore.test.ts
git commit -m "feat: chatStore guarda el último emoji de cada participante"
```

---

## Task 3: Pintar el destello en el chip del participante

**Files:**
- Modify: `web/src/chat/ChatPanel.tsx:52-60`
- Modify: `web/src/pages/Room.tsx:36-40`, `:236`
- Modify: `web/src/theme.css` (sección «Chat» y bloque de movimiento reducido)

**Interfaces:**
- Consumes: `ChatState.flashes`, `dropFlash` (Task 2).
- Produces: `ChatPanel` gana la prop `onFlashEnd: (pid: string, id: number) => void`. La acción `{ t: 'drop-flash'; pid: string; id: number }` de `RoomChatAction`.

- [ ] **Step 1: Añadir la acción `drop-flash` en Room**

En `web/src/pages/Room.tsx`, sustituye el bloque de las líneas 36-40 por:

```ts
type RoomChatAction =
  | ServerMsg
  | { t: 'drop-reaction'; id: number }
  | { t: 'drop-flash'; pid: string; id: number }

function roomChatReducer(s: ChatState, a: RoomChatAction): ChatState {
  if (a.t === 'drop-reaction') return dropReaction(s, a.id)
  if (a.t === 'drop-flash') return dropFlash(s, a.pid, a.id)
  return chatReducer(s, a)
}
```

Y amplía el import de la línea 8:

```ts
import { chatReducer, dropFlash, dropReaction, initialChat, type ChatState } from '../chat/chatStore'
```

- [ ] **Step 2: Pasar el handler al ChatPanel**

En `web/src/pages/Room.tsx`, línea 236, sustituye:

```tsx
        <ChatPanel token={token} state={chat} send={m => sendRef.current(m)} />
```

por:

```tsx
        <ChatPanel token={token} state={chat} send={m => sendRef.current(m)}
          onFlashEnd={(pid, id) => dispatchChat({ t: 'drop-flash', pid, id })} />
```

- [ ] **Step 3: Pintar el destello en el chip**

En `web/src/chat/ChatPanel.tsx`, amplía la firma (líneas 7-13):

```tsx
export function ChatPanel({
  token, state, send, onFlashEnd,
}: {
  token: string
  state: ChatState
  send: (m: ClientMsg) => void
  onFlashEnd: (pid: string, id: number) => void
}) {
```

Y sustituye la lista de participantes (líneas 53-60) por:

```tsx
      <ul className="participants">
        {state.participants.map(p => {
          const flash = state.flashes[p.id]
          return (
            <li key={p.id} className={p.active ? undefined : 'away'} title={p.active ? undefined : 'ausente'}>
              <span className="dot" style={{ background: p.color }} />
              {p.name}
              {/* La key es el id del destello, no el del participante: así una
                  reacción nueva remonta el span y la animación arranca de cero
                  en vez de quedarse a medias. */}
              {flash && (
                <span key={flash.id} className="reaction-flash" aria-hidden
                  onAnimationEnd={() => onFlashEnd(p.id, flash.id)}>
                  {flash.emoji}
                </span>
              )}
            </li>
          )
        })}
      </ul>
```

- [ ] **Step 4: Añadir el CSS del destello**

En `web/src/theme.css`, justo después de la regla `.participants .dot { … }` (termina en la línea 951), añade:

```css
.reaction-flash {
  font-size: 0.85rem;
  line-height: 1;
  animation: flash-pop 2.5s var(--ease-out) forwards;
}

@keyframes flash-pop {
  0% { opacity: 0; transform: scale(0.4); }
  12% { opacity: 1; transform: scale(1.25); }
  22% { transform: scale(1); }
  75% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(1); }
}
```

Y dentro del bloque `@media (prefers-reduced-motion: reduce)` que empieza en la línea 1084, sustituye la regla del overlay por:

```css
  /* Las reacciones conservan su duración (la lógica de retirada depende de
     animationend) pero se desvanecen en el sitio en vez de volar. */
  .reaction-overlay span,
  .reaction-flash { animation-name: fade-hold; }
```

- [ ] **Step 5: Verificar tipos y tests**

Run: `cd web && npx tsc --noEmit && cd .. && npm test -w web`
Expected: sin errores de tipos; todos los tests pasan.

- [ ] **Step 6: Verificar a ojo**

Run: `npm start` (o los dos terminales de desarrollo del README), entra en una sala desde dos pestañas con nombres distintos y pulsa un emoji en una.
Expected: el emoji aparece pequeño junto al nombre de quien lo pulsó **en las dos pestañas**, y desaparece a los ~2,5 s dejando el chip como estaba. Pulsar dos veces seguidas reinicia la animación con el emoji nuevo.

- [ ] **Step 7: Commit**

```bash
git add web/src/chat/ChatPanel.tsx web/src/pages/Room.tsx web/src/theme.css
git commit -m "feat: la lista de participantes destella el emoji de quien reacciona"
```

---

## Task 4: Lista de accesos rápidos en funciones puras

**Files:**
- Create: `web/src/chat/quickEmojis.ts`
- Test: `web/test/quickEmojis.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `QUICK_KEY: string` (`'jbg-quick-emojis'`)
  - `MAX_QUICK: number` (`12`)
  - `DEFAULT_QUICK: string[]`
  - `parseQuick(raw: string | null): string[]`
  - `addQuick(list: string[], emoji: string): string[]`
  - `removeQuick(list: string[], emoji: string): string[]`

  Los usan los Tasks 6 y 7.

- [ ] **Step 1: Escribir los tests que fallan**

Crea `web/test/quickEmojis.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { addQuick, DEFAULT_QUICK, MAX_QUICK, parseQuick, removeQuick } from '../src/chat/quickEmojis'

describe('parseQuick', () => {
  it('sin nada guardado devuelve los emojis por defecto', () => {
    expect(parseQuick(null)).toEqual(DEFAULT_QUICK)
  })
  it('JSON corrupto cae a los valores por defecto', () => {
    expect(parseQuick('{no es json')).toEqual(DEFAULT_QUICK)
  })
  it('un valor que no es array cae a los valores por defecto', () => {
    expect(parseQuick('{"a":1}')).toEqual(DEFAULT_QUICK)
    expect(parseQuick('"🔥"')).toEqual(DEFAULT_QUICK)
  })
  it('descarta entradas que no son string y cadenas vacías', () => {
    expect(parseQuick('["🔥", 3, null, "", "😂"]')).toEqual(['🔥', '😂'])
  })
  it('deduplica conservando el primer sitio', () => {
    expect(parseQuick('["🔥", "😂", "🔥"]')).toEqual(['🔥', '😂'])
  })
  it('recorta al tope', () => {
    const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => `e${i}`))
    expect(parseQuick(many)).toHaveLength(MAX_QUICK)
  })
  it('una lista vacía guardada se respeta, no se repuebla', () => {
    expect(parseQuick('[]')).toEqual([])
  })
})

describe('addQuick', () => {
  it('añade al final', () => {
    expect(addQuick(['🔥'], '😂')).toEqual(['🔥', '😂'])
  })
  it('no duplica', () => {
    const list = ['🔥', '😂']
    expect(addQuick(list, '🔥')).toBe(list)
  })
  it('no pasa del tope', () => {
    const full = Array.from({ length: MAX_QUICK }, (_, i) => `e${i}`)
    expect(addQuick(full, '🆕')).toBe(full)
  })
})

describe('removeQuick', () => {
  it('quita el emoji indicado y deja el resto en orden', () => {
    expect(removeQuick(['🔥', '😂', '💀'], '😂')).toEqual(['🔥', '💀'])
  })
  it('quitar algo que no está no cambia la lista', () => {
    expect(removeQuick(['🔥'], '😂')).toEqual(['🔥'])
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npm test -w web -- quickEmojis`
Expected: FAIL — no se puede resolver `../src/chat/quickEmojis`.

- [ ] **Step 3: Implementar el módulo**

Crea `web/src/chat/quickEmojis.ts`:

```ts
// Accesos rápidos de la barra de reacciones, elegidos por cada espectador.
// Este módulo NO toca localStorage a propósito: Vitest corre en entorno node,
// donde no existe. El componente lee y escribe la clave; aquí solo hay lógica
// pura, que es lo que se prueba. Mismo reparto que parseStoredVolume.

export const QUICK_KEY = 'jbg-quick-emojis'

// Tope necesario: en pantalla completa la barra es una fila única dentro de un
// panel estrecho.
export const MAX_QUICK = 12

export const DEFAULT_QUICK = ['😂', '❤️', '😱', '🤯', '🍿', '🔥', '👏', '😭', '💀', '🙈']

export function parseQuick(raw: string | null): string[] {
  if (raw === null) return DEFAULT_QUICK
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return DEFAULT_QUICK }
  if (!Array.isArray(parsed)) return DEFAULT_QUICK
  // Una lista vacía es una elección legítima y se respeta; solo se repuebla
  // cuando no hay nada guardado o lo guardado es inservible.
  return [...new Set(parsed.filter((e): e is string => typeof e === 'string' && e !== ''))].slice(0, MAX_QUICK)
}

export function addQuick(list: string[], emoji: string): string[] {
  if (list.includes(emoji) || list.length >= MAX_QUICK) return list
  return [...list, emoji]
}

export function removeQuick(list: string[], emoji: string): string[] {
  return list.filter(e => e !== emoji)
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npm test -w web -- quickEmojis`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/chat/quickEmojis.ts web/test/quickEmojis.test.ts
git commit -m "feat: lógica pura de los accesos rápidos de emojis"
```

---

## Task 5: Búsqueda y categorías de emojis

Sin datos todavía: este módulo define el tipo de fila y la búsqueda, y el Task 6 genera el fichero de datos que lo cumple. Ese orden evita que el fichero generado dependa de algo que aún no existe.

**Files:**
- Create: `web/src/chat/emojiSearch.ts`
- Test: `web/test/emojiSearch.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `type EmojiRow = [string, string, string, number]` — `[unicode, etiqueta, palabras clave, grupo]`
  - `EMOJI_GROUPS: { group: number; label: string; icon: string }[]`
  - `SEARCH_LIMIT: number` (`120`)
  - `normalize(s: string): string`
  - `searchEmojis(catalog: EmojiRow[], query: string, limit?: number): EmojiRow[]`

  Los usan los Tasks 6 y 7.

- [ ] **Step 1: Escribir los tests que fallan**

Crea `web/test/emojiSearch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { EMOJI_GROUPS, normalize, searchEmojis, SEARCH_LIMIT, type EmojiRow } from '../src/chat/emojiSearch'

const CATALOG: EmojiRow[] = [
  ['🍿', 'palomitas', 'maíz cine', 4],
  ['❤️', 'corazón rojo', 'amor', 8],
  ['🔥', 'fuego', 'llama caliente', 5],
  ['😂', 'cara llorando de risa', 'risa lágrima', 0],
]

describe('normalize', () => {
  it('quita acentos y pasa a minúsculas', () => {
    expect(normalize('CoraZÓN')).toBe('corazon')
    expect(normalize('maíz')).toBe('maiz')
  })
})

describe('searchEmojis', () => {
  it('encuentra por etiqueta ignorando acentos', () => {
    expect(searchEmojis(CATALOG, 'corazon').map(r => r[0])).toEqual(['❤️'])
  })
  it('encuentra por palabra clave', () => {
    expect(searchEmojis(CATALOG, 'cine').map(r => r[0])).toEqual(['🍿'])
  })
  it('encuentra por trozo de palabra', () => {
    expect(searchEmojis(CATALOG, 'risa').map(r => r[0])).toEqual(['😂'])
  })
  it('una búsqueda vacía no devuelve nada', () => {
    expect(searchEmojis(CATALOG, '   ')).toEqual([])
  })
  it('respeta el tope de resultados', () => {
    const many: EmojiRow[] = Array.from({ length: 500 }, (_, i) => [`e${i}`, 'cosa', '', 0])
    expect(searchEmojis(many, 'cosa')).toHaveLength(SEARCH_LIMIT)
    expect(searchEmojis(many, 'cosa', 5)).toHaveLength(5)
  })
})

describe('EMOJI_GROUPS', () => {
  it('no incluye el grupo 2, que son modificadores y no emotes', () => {
    expect(EMOJI_GROUPS.some(g => g.group === 2)).toBe(false)
  })
  it('cubre los nueve grupos de emotes', () => {
    expect(EMOJI_GROUPS.map(g => g.group)).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9])
  })
})
```

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npm test -w web -- emojiSearch`
Expected: FAIL — no se puede resolver `../src/chat/emojiSearch`.

- [ ] **Step 3: Implementar el módulo**

Crea `web/src/chat/emojiSearch.ts`:

```ts
// Cada fila del catálogo: [unicode, etiqueta, palabras clave, grupo].
// Formato de tupla y no de objeto porque son ~1.900 filas y los nombres de
// campo repetidos costarían más que los propios datos.
export type EmojiRow = [string, string, string, number]

// El grupo 2 de emojibase son modificadores de tono de piel y de pelo: no son
// emotes y no deben aparecer en el selector, así que no tiene pestaña.
export const EMOJI_GROUPS: { group: number; label: string; icon: string }[] = [
  { group: 0, label: 'Caras', icon: '😀' },
  { group: 1, label: 'Gente', icon: '👋' },
  { group: 3, label: 'Animales', icon: '🐱' },
  { group: 4, label: 'Comida', icon: '🍕' },
  { group: 5, label: 'Viajes', icon: '🚗' },
  { group: 6, label: 'Actividades', icon: '🎉' },
  { group: 7, label: 'Objetos', icon: '💡' },
  { group: 8, label: 'Símbolos', icon: '❤️' },
  { group: 9, label: 'Banderas', icon: '🏳️' },
]

// Sin tope, buscar «a» metería más de mil botones en el DOM de golpe.
export const SEARCH_LIMIT = 120

export function normalize(s: string): string {
  // NFD separa la letra de su tilde y el rango borra las marcas combinantes.
  // Escrito con escapes a propósito: los caracteres literales son invisibles y
  // no sobreviven bien a un copiar y pegar.
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export function searchEmojis(catalog: EmojiRow[], query: string, limit = SEARCH_LIMIT): EmojiRow[] {
  const q = normalize(query.trim())
  if (q === '') return []
  const out: EmojiRow[] = []
  for (const row of catalog) {
    if (normalize(row[1]).includes(q) || normalize(row[2]).includes(q)) {
      out.push(row)
      if (out.length === limit) break
    }
  }
  return out
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npm test -w web -- emojiSearch`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/chat/emojiSearch.ts web/test/emojiSearch.test.ts
git commit -m "feat: búsqueda y categorías de emojis"
```

---

## Task 6: Generar y commitear el catálogo de emojis

**Files:**
- Create: `web/scripts/gen-emoji-catalog.mjs`
- Create: `web/src/chat/emojiCatalog.ts` (generado por el script, ~105 KB)
- Test: `web/test/emojiSearch.test.ts` (se le añade un bloque de cordura)

**Interfaces:**
- Consumes: `EmojiRow` de `emojiSearch.ts` (Task 5).
- Produces: `EMOJI_CATALOG: EmojiRow[]`, importado dinámicamente por el Task 7.

- [ ] **Step 1: Escribir el generador**

Crea `web/scripts/gen-emoji-catalog.mjs`:

```js
// Regenera web/src/chat/emojiCatalog.ts desde emojibase-data en español.
//
//   node web/scripts/gen-emoji-catalog.mjs
//
// Se ejecuta A MANO, solo cuando Unicode saque emojis nuevos. Queda fuera de
// `npm run build` y de `npm test` a propósito: nadie debería necesitar red para
// compilar el proyecto ni para pasar los tests.
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Versión fijada, no `latest`: una regeneración no debe cambiar el resultado
// por su cuenta entre una ejecución y la siguiente.
const SOURCE = 'https://cdn.jsdelivr.net/npm/emojibase-data@16/es/compact.json'
// Modificadores de tono de piel y de pelo. No son emotes.
const COMPONENT_GROUP = 2

const res = await fetch(SOURCE)
if (!res.ok) throw new Error(`${SOURCE} respondió ${res.status}`)
const data = await res.json()

const rows = data
  .filter(e => e.group !== undefined && e.group !== COMPONENT_GROUP)
  .sort((a, b) => a.order - b.order)
  .map(e => [e.unicode, e.label, (e.tags ?? []).join(' '), e.group])

const out = `// GENERADO — no editar a mano. Regenerar con:
//   node web/scripts/gen-emoji-catalog.mjs
// Fuente: ${SOURCE}
import type { EmojiRow } from './emojiSearch'

export const EMOJI_CATALOG: EmojiRow[] = ${JSON.stringify(rows)}
`

const here = dirname(fileURLToPath(import.meta.url))
await writeFile(join(here, '../src/chat/emojiCatalog.ts'), out)
console.log(`${rows.length} emojis escritos`)
```

- [ ] **Step 2: Ejecutarlo**

Run: `node web/scripts/gen-emoji-catalog.mjs`
Expected: imprime `1906 emojis escritos` y crea `web/src/chat/emojiCatalog.ts`. Si el número baja de 1.800, la fuente ha cambiado de forma: para y revisa antes de seguir.

- [ ] **Step 3: Escribir el test de cordura**

Añade al final de `web/test/emojiSearch.test.ts`:

```ts
describe('EMOJI_CATALOG', () => {
  it('trae el catálogo completo, bien formado y sin modificadores', async () => {
    const { EMOJI_CATALOG } = await import('../src/chat/emojiCatalog')
    expect(EMOJI_CATALOG.length).toBeGreaterThan(1800)
    expect(EMOJI_CATALOG.every(r => r.length === 4)).toBe(true)
    expect(EMOJI_CATALOG.every(r => typeof r[0] === 'string' && r[0] !== '')).toBe(true)
    // El grupo 2 son tonos de piel y pelo: no deben haberse colado.
    expect(EMOJI_CATALOG.some(r => r[3] === 2)).toBe(false)
    // Las etiquetas vienen en castellano.
    expect(EMOJI_CATALOG.find(r => r[0] === '🍿')?.[1]).toBe('palomitas')
  })

  it('la búsqueda en castellano funciona sobre el catálogo real', async () => {
    const { EMOJI_CATALOG } = await import('../src/chat/emojiCatalog')
    expect(searchEmojis(EMOJI_CATALOG, 'palomitas').map(r => r[0])).toContain('🍿')
    expect(searchEmojis(EMOJI_CATALOG, 'corazon').length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npm test -w web -- emojiSearch`
Expected: PASS, 10 tests.

- [ ] **Step 5: Verificar tipos**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: sin salida. Comprobar tipos aquí importa: el fichero generado tiene 1.906 filas anotadas como `EmojiRow`, y un fallo de forma sale justo aquí.

- [ ] **Step 6: Commit**

```bash
git add web/scripts/gen-emoji-catalog.mjs web/src/chat/emojiCatalog.ts web/test/emojiSearch.test.ts
git commit -m "feat: catálogo de emojis en español generado desde emojibase"
```

---

## Task 7: El modal de emojis y la barra personalizable

**Files:**
- Create: `web/src/chat/EmojiPicker.tsx`
- Modify: `web/src/chat/ReactionsBar.tsx` (se reescribe entero)
- Modify: `web/src/theme.css` (sección «Reacciones»)

**Interfaces:**
- Consumes: `parseQuick`, `addQuick`, `removeQuick`, `QUICK_KEY`, `MAX_QUICK` (Task 4); `EMOJI_GROUPS`, `searchEmojis`, `EmojiRow` (Task 5); `EMOJI_CATALOG` (Task 6).
- Produces: `ReactionsBar` mantiene su firma actual `{ send }` — el estado de la lista es interno, así que ningún otro componente cambia.

- [ ] **Step 1: Escribir el modal**

Crea `web/src/chat/EmojiPicker.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { EMOJI_GROUPS, searchEmojis, type EmojiRow } from './emojiSearch'
import { MAX_QUICK } from './quickEmojis'

export function EmojiPicker({
  quick, onAdd, onRemove, onClose,
}: {
  quick: string[]
  onAdd: (emoji: string) => void
  onRemove: (emoji: string) => void
  onClose: () => void
}) {
  const [catalog, setCatalog] = useState<EmojiRow[] | null>(null)
  const [group, setGroup] = useState(EMOJI_GROUPS[0].group)
  const [query, setQuery] = useState('')

  // El catálogo son ~105 KB: se carga la primera vez que se abre el modal, no
  // al entrar en la sala. Vite lo separa en su propio chunk.
  useEffect(() => {
    let cancelled = false
    import('./emojiCatalog')
      .then(m => { if (!cancelled) setCatalog(m.EMOJI_CATALOG) })
      .catch(() => { if (!cancelled) setCatalog([]) })
    return () => { cancelled = true }
  }, [])

  const searching = query.trim() !== ''
  const full = quick.length >= MAX_QUICK
  const shown = catalog === null ? []
    : searching ? searchEmojis(catalog, query)
    : catalog.filter(r => r[3] === group)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* Sin cierre con Escape: en pantalla completa el navegador se queda esa
          tecla para salir del modo y no se puede evitar, así que sería un atajo
          que funciona a medias. Se cierra con el fondo y con la ✕. */}
      <div className="modal emoji-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" aria-label="Cerrar" onClick={onClose}>✕</button>

        <h2 className="emoji-heading">Tus accesos rápidos</h2>
        {quick.length === 0
          ? <p className="hint">Ninguno todavía: elige abajo los que quieras.</p>
          : <ul className="quick-chips">
              {quick.map(e => (
                <li key={e}>
                  <span aria-hidden>{e}</span>
                  <button type="button" aria-label={`Quitar ${e}`} onClick={() => onRemove(e)}>✕</button>
                </li>
              ))}
            </ul>}
        {full && <p className="hint">Máximo {MAX_QUICK}: quita alguno para añadir más.</p>}

        <input className="emoji-search" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Buscar emoji…" aria-label="Buscar emoji" />

        {!searching && (
          <div className="emoji-tabs" role="tablist">
            {EMOJI_GROUPS.map(g => (
              <button key={g.group} type="button" role="tab" aria-selected={g.group === group}
                aria-label={g.label} title={g.label}
                className={g.group === group ? 'is-active' : undefined}
                onClick={() => setGroup(g.group)}>{g.icon}</button>
            ))}
          </div>
        )}

        {catalog === null ? (
          <p className="gif-picker-status">Cargando emojis…</p>
        ) : searching && shown.length === 0 ? (
          <p className="gif-picker-status">Ningún emoji coincide.</p>
        ) : (
          <div className="emoji-grid">
            {shown.map(r => (
              <button key={r[0]} type="button" aria-label={r[1]} title={r[1]}
                disabled={full || quick.includes(r[0])}
                onClick={() => onAdd(r[0])}>{r[0]}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Reescribir la barra de reacciones**

Sustituye el contenido completo de `web/src/chat/ReactionsBar.tsx` por:

```tsx
import { useState } from 'react'
import { EmojiPicker } from './EmojiPicker'
import { addQuick, parseQuick, QUICK_KEY, removeQuick } from './quickEmojis'
import type { ClientMsg } from '../types'

export function ReactionsBar({ send }: { send: (m: ClientMsg) => void }) {
  // La lista vive aquí porque esta barra es su único consumidor. Persistencia
  // por navegador: no hay cuentas y las salas son efímeras.
  const [quick, setQuick] = useState(() => parseQuick(localStorage.getItem(QUICK_KEY)))
  const [pickerOpen, setPickerOpen] = useState(false)

  const update = (next: string[]) => {
    setQuick(next)
    localStorage.setItem(QUICK_KEY, JSON.stringify(next))
  }

  return (
    <div className="reactions-bar">
      {quick.map(emoji => (
        <button key={emoji} type="button" onClick={() => send({ t: 'reaction', emoji })}>
          {emoji}
        </button>
      ))}
      <button type="button" className="btn-add-emoji" aria-label="Elegir emojis" title="Elegir emojis"
        onClick={() => setPickerOpen(true)}>+</button>

      {pickerOpen && (
        <EmojiPicker
          quick={quick}
          onAdd={e => update(addQuick(quick, e))}
          onRemove={e => update(removeQuick(quick, e))}
          onClose={() => setPickerOpen(false)} />
      )}
    </div>
  )
}
```

- [ ] **Step 3: Añadir el CSS del modal**

En `web/src/theme.css`, al final de la sección «Reacciones» (justo antes del comentario `/* ─── Chat ─── */` de la línea 909), añade:

```css
.btn-add-emoji {
  font-size: 1.05rem;
  line-height: 1;
  padding: 0.45rem 0.6rem;
  border-radius: 999px;
  color: var(--text-faint);
  border-color: var(--line-soft);
}

.btn-add-emoji:hover {
  color: var(--marquee);
  border-color: color-mix(in oklab, var(--marquee) 40%, transparent);
}

.emoji-modal {
  width: min(460px, 100%);
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.emoji-heading {
  margin: 0 2rem 0 0;
  font-size: 0.95rem;
  font-weight: 600;
  font-family: var(--font-body);
}

.quick-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.quick-chips li {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  background: var(--raised);
  border-radius: 999px;
  padding: 0.15rem 0.3rem 0.15rem 0.5rem;
  font-size: 1.05rem;
  line-height: 1;
}

.quick-chips button {
  width: 20px;
  height: 20px;
  padding: 0;
  font-size: 0.7rem;
  line-height: 1;
  border-radius: 50%;
  border-color: transparent;
  color: var(--text-faint);
}

.quick-chips button:hover {
  color: var(--danger);
  border-color: color-mix(in oklab, var(--danger) 45%, transparent);
}

.emoji-search { width: 100%; }

.emoji-tabs {
  display: flex;
  gap: 0.2rem;
  overflow-x: auto;
  border-bottom: 1px solid var(--line-soft);
  padding-bottom: 0.4rem;
}

.emoji-tabs button {
  font-size: 1.05rem;
  line-height: 1;
  padding: 0.3rem 0.45rem;
  border-color: transparent;
  border-radius: 8px;
  flex-shrink: 0;
}

.emoji-tabs button.is-active {
  background: var(--raised);
  border-color: color-mix(in oklab, var(--marquee) 40%, transparent);
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(38px, 1fr));
  gap: 0.15rem;
  /* Alto fijo: al cambiar de categoría el modal no debe pegar saltos. */
  height: 44vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.emoji-grid button {
  font-size: 1.3rem;
  line-height: 1;
  padding: 0.3rem 0;
  border-color: transparent;
  border-radius: 8px;
}

.emoji-grid button:hover:not(:disabled) {
  background: var(--raised);
  border-color: color-mix(in oklab, var(--marquee) 40%, transparent);
}

.emoji-grid button:disabled { opacity: 0.28; }
```

- [ ] **Step 4: Verificar tipos y tests**

Run: `cd web && npx tsc --noEmit && cd .. && npm test`
Expected: sin errores de tipos; todos los tests de server y web pasan.

- [ ] **Step 5: Verificar a ojo**

Run: arranca la app y entra en una sala.
Expected, en este orden:
1. La barra muestra los diez emojis de siempre más un botón `+`.
2. `+` abre el modal; el catálogo tarda un instante en cargar («Cargando emojis…») y luego se ve la rejilla de «Caras».
3. Buscar «palomitas» encuentra 🍿; buscar «corazon» sin tilde encuentra corazones.
4. Al elegir uno, aparece al final de la barra y su botón queda deshabilitado en la rejilla.
5. La `✕` de un chip lo quita de la barra.
6. Al llegar a 12 sale el aviso y la rejilla se deshabilita entera.
7. Recargar la página conserva la selección.
8. Pulsar un emoji de la barra sigue lanzándolo sobre el vídeo y destellando en la lista de participantes.

- [ ] **Step 6: Commit**

```bash
git add web/src/chat/EmojiPicker.tsx web/src/chat/ReactionsBar.tsx web/src/theme.css
git commit -m "feat: modal propio de emojis y accesos rápidos personalizables"
```

---

## Task 8: `isTypingTarget` para los atajos de una letra

`spaceBelongsTo` no sirve para la tecla `F`: cuenta `BUTTON` como propietario, porque el espacio pulsa el botón enfocado, pero la `F` sí debe funcionar con un botón enfocado.

**Files:**
- Modify: `web/src/player/format.ts` (añadir al final)
- Test: `web/test/format.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `isTypingTarget(tagName?: string, inputType?: string, isContentEditable?: boolean): boolean`. Lo usan los Tasks 10 y 12.

- [ ] **Step 1: Escribir los tests que fallan**

Añade al final de `web/test/format.test.ts`:

```ts
describe('isTypingTarget', () => {
  it.each([
    ['INPUT', 'text', true],
    ['INPUT', undefined, true],
    ['TEXTAREA', undefined, true],
    ['SELECT', undefined, true],
  ])('%s/%s se está escribiendo', (tag, type, expected) => {
    expect(isTypingTarget(tag, type)).toBe(expected)
  })

  it('un range no recibe texto', () => {
    expect(isTypingTarget('INPUT', 'range')).toBe(false)
  })

  it('contenteditable cuenta como escritura', () => {
    expect(isTypingTarget('DIV', undefined, true)).toBe(true)
  })

  it('un botón NO cuenta: la F debe funcionar con un botón enfocado', () => {
    expect(isTypingTarget('BUTTON')).toBe(false)
    // …a diferencia del espacio, que sí pertenece al botón.
    expect(spaceBelongsTo('BUTTON')).toBe(true)
  })

  it('sin foco en nada, no se está escribiendo', () => {
    expect(isTypingTarget(undefined, undefined, undefined)).toBe(false)
  })
})
```

Amplía el import de la línea 2 para incluir `isTypingTarget`.

- [ ] **Step 2: Correr los tests y verificar que fallan**

Run: `npm test -w web -- format`
Expected: FAIL — `isTypingTarget` no está exportado.

- [ ] **Step 3: Implementar la función**

Añade al final de `web/src/player/format.ts`:

```ts
// ¿El elemento con foco está recibiendo texto? Los atajos de una sola letra
// (F = pantalla completa) no deben dispararse mientras se escribe en el chat.
// No vale `spaceBelongsTo`: esa cuenta BUTTON como propietario porque el
// espacio pulsa el botón enfocado, pero la F sí debe funcionar ahí.
export function isTypingTarget(tagName?: string, inputType?: string, isContentEditable?: boolean): boolean {
  if (isContentEditable) return true
  if (tagName === 'TEXTAREA' || tagName === 'SELECT') return true
  if (tagName === 'INPUT') return inputType !== 'range'
  return false
}
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npm test -w web -- format`
Expected: PASS, incluidos los que ya existían.

- [ ] **Step 5: Commit**

```bash
git add web/src/player/format.ts web/test/format.test.ts
git commit -m "feat: isTypingTarget para los atajos de una sola tecla"
```

---

## Task 9: Hook de pantalla completa con respaldo «modo cine»

**Files:**
- Create: `web/src/player/useFullscreen.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `useFullscreen(ref: RefObject<HTMLElement | null>): { active: boolean; cinema: boolean; toggle: () => void }`. Lo usa el Task 10.

- [ ] **Step 1: Escribir el hook**

Crea `web/src/player/useFullscreen.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

// Safari sigue exponiendo las variantes con prefijo, y son las únicas que
// existen en algunas versiones que aún se usan.
interface LegacyElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void
}
interface LegacyDocument extends Document {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

const legacyDoc = (): LegacyDocument => document as LegacyDocument

function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? legacyDoc().webkitFullscreenElement ?? null
}

function exitFullscreen(): void {
  if (document.exitFullscreen) { void document.exitFullscreen().catch(() => {}); return }
  legacyDoc().webkitExitFullscreen?.()
}

export function useFullscreen(ref: RefObject<HTMLElement | null>): {
  active: boolean; cinema: boolean; toggle: () => void
} {
  const [nativeOn, setNativeOn] = useState(false)
  // «Modo cine»: el iPhone no deja poner un contenedor HTML a pantalla completa
  // —solo el <video> desnudo, sin overlays—, así que allí se ocupa la ventana
  // desde dentro de la página. El chat flotante sigue viéndose.
  const [cinema, setCinema] = useState(false)
  const cinemaRef = useRef(cinema)
  cinemaRef.current = cinema

  // Salir con Escape o con el botón del navegador no pasa por `toggle`: sin
  // esto la clase CSS se quedaría puesta con la pantalla ya restaurada.
  useEffect(() => {
    const sync = () => setNativeOn(fullscreenElement() !== null)
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])

  // El modo cine no lo cierra el navegador: hay que atender Escape a mano.
  useEffect(() => {
    if (!cinema) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCinema(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cinema])

  // Sin esto, el scroll del documento deja asomar la cabecera por debajo.
  useEffect(() => {
    if (!cinema) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [cinema])

  // Room desmonta el player entero cuando ffmpeg falla: dejar la pestaña en
  // pantalla completa sobre la pantalla de error sería una trampa sin salida
  // visible.
  useEffect(() => () => { if (fullscreenElement()) exitFullscreen() }, [])

  const toggle = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (fullscreenElement()) { exitFullscreen(); return }
    if (cinemaRef.current) { setCinema(false); return }

    const legacy = el as LegacyElement
    const request = el.requestFullscreen?.bind(el) ?? legacy.webkitRequestFullscreen?.bind(legacy)
    if (!request) { setCinema(true); return }
    // Puede rechazar (permiso denegado, gesto no considerado de confianza): en
    // vez de dejar un botón muerto, se cae al modo cine.
    Promise.resolve(request()).catch(() => setCinema(true))
  }, [ref])

  return { active: nativeOn || cinema, cinema, toggle }
}
```

- [ ] **Step 2: Verificar tipos**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: sin salida. El hook todavía no se usa en ningún sitio; esto solo comprueba que compila.

- [ ] **Step 3: Commit**

```bash
git add web/src/player/useFullscreen.ts
git commit -m "feat: hook de pantalla completa con respaldo modo cine"
```

---

## Task 10: Botón, doble clic y tecla F

**Files:**
- Modify: `web/src/player/Player.tsx`
- Modify: `web/src/pages/Room.tsx`

**Interfaces:**
- Consumes: `useFullscreen` (Task 9), `isTypingTarget` (Task 8).
- Produces: `Player` gana las props `fullscreen: boolean` y `onToggleFullscreen: () => void`. `Room` expone `gridRef` sobre el `div.room-grid` y le pone la clase `room-grid--fs` (y `room-grid--cinema` cuando toca).

- [ ] **Step 1: Añadir los iconos y la constante al Player**

En `web/src/player/Player.tsx`, junto al resto de iconos (tras `MutedIcon`, línea 38), añade:

```tsx
const EnterFullscreenIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
    <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
  </svg>
)
const ExitFullscreenIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
    <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
  </svg>
)
```

Y junto a las demás constantes del fichero (tras `DRAG_WATCHDOG_MS`, línea 17):

```ts
// Ventana para distinguir un clic (play/pausa) de un doble clic (pantalla
// completa). Sin ella, el doble clic mandaría dos play/pausa al servidor y
// llenaría el chat de dos mensajes de sistema por cada entrada a pantalla
// completa.
const DOUBLE_CLICK_MS = 220
```

- [ ] **Step 2: Ampliar la firma y añadir la lógica**

Cambia la firma del componente (líneas 40-43) a:

```tsx
export function Player({ token, info, send, lastState, welcomeCount, fullscreen, onToggleFullscreen }: {
  token: string; info: RoomInfo; send: (m: ClientMsg) => void; lastState: LastState | null
  welcomeCount: number
  fullscreen: boolean
  onToggleFullscreen: () => void
}) {
```

Junto a `sendRef` (línea 84), añade:

```tsx
  const toggleFsRef = useRef(onToggleFullscreen)
  toggleFsRef.current = onToggleFullscreen
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
```

Después del efecto de la tecla espacio (termina en la línea 173), añade:

```tsx
  // F = pantalla completa, salvo que se esté escribiendo. Aquí no vale
  // `spaceBelongsTo`: cuenta BUTTON como propietario de la tecla, y la F sí
  // debe funcionar con un botón enfocado.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return
      const t = e.target as HTMLElement | null
      if (isTypingTarget(t?.tagName, (t as HTMLInputElement | null)?.type, t?.isContentEditable)) return
      e.preventDefault()
      toggleFsRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => () => { if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current) }, [])

  const onVideoClick = () => {
    if (clickTimerRef.current !== null) return
    clickTimerRef.current = setTimeout(() => { clickTimerRef.current = null; togglePlay() }, DOUBLE_CLICK_MS)
  }

  const onVideoDoubleClick = () => {
    if (clickTimerRef.current !== null) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null }
    toggleFsRef.current()
  }
```

Amplía el import de la línea 5 para incluir `isTypingTarget`:

```ts
import { clampPosition, formatClock, isTypingTarget, MAX_VOLUME, parseClock, parseStoredVolume, positionGradient, spaceBelongsTo, volumeGradient } from './format'
```

- [ ] **Step 3: Conectar el vídeo y añadir el botón**

Cambia la etiqueta `<video>` (línea 340) a:

```tsx
      <video ref={videoRef} playsInline onClick={onVideoClick} onDoubleClick={onVideoDoubleClick}>
```

Y al final de `.controls`, después del `<select>` de subtítulos (línea 416), añade:

```tsx
        <button type="button" className="btn-fullscreen"
          aria-label={fullscreen ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)'}
          title={fullscreen ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)'}
          onClick={onToggleFullscreen}>
          {fullscreen ? <ExitFullscreenIcon /> : <EnterFullscreenIcon />}
        </button>
```

- [ ] **Step 4: Conectar Room**

En `web/src/pages/Room.tsx`, añade el import:

```ts
import { useFullscreen } from '../player/useFullscreen'
```

Junto al resto de refs (tras `sendRef`, línea 63):

```tsx
  const gridRef = useRef<HTMLDivElement>(null)
  const { active: fullscreen, cinema, toggle: toggleFullscreen } = useFullscreen(gridRef)
```

Y sustituye el `div.room-grid` (línea 230) por:

```tsx
      <div ref={gridRef} className={`room-grid${fullscreen ? ' room-grid--fs' : ''}${cinema ? ' room-grid--cinema' : ''}`}>
```

Pasa las props nuevas al Player (línea 232):

```tsx
          <Player token={token} info={info} send={m => sendRef.current(m)} lastState={lastState} welcomeCount={welcomeCount}
            fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />
```

- [ ] **Step 5: Verificar tipos y tests**

Run: `cd web && npx tsc --noEmit && cd .. && npm test`
Expected: sin errores; todos los tests pasan.

- [ ] **Step 6: Verificar a ojo (sin el CSS todavía)**

Run: arranca la app y entra en una sala.
Expected: el botón de pantalla completa entra y sale; la tecla `F` también; el doble clic sobre el vídeo también, **sin** dejar dos mensajes de sistema en el chat; escribir una `f` en el chat no dispara nada; Escape sale. El aspecto todavía estará roto (el vídeo no llena la pantalla): eso es el Task 11.

- [ ] **Step 7: Commit**

```bash
git add web/src/player/Player.tsx web/src/pages/Room.tsx
git commit -m "feat: botón, doble clic y tecla F para pantalla completa"
```

---

## Task 11: CSS de pantalla completa

**Files:**
- Modify: `web/src/theme.css` (bloque nuevo justo antes de `@media (prefers-reduced-motion: reduce)`)

**Interfaces:**
- Consumes: las clases `room-grid--fs` y `room-grid--cinema` (Task 10).
- Produces: la clase `is-idle`, que el Task 12 añadirá al mismo contenedor.

- [ ] **Step 1: Añadir el bloque de pantalla completa**

En `web/src/theme.css`, inmediatamente **antes** de `@media (prefers-reduced-motion: reduce) {` (línea 1084), añade:

```css
/* ─── Pantalla completa ───
   El elemento que va a pantalla completa es .room-grid, porque ya contiene el
   vídeo Y el chat: así el árbol de React no cambia al entrar y salir, y el
   ChatPanel no se desmonta (no se pierde lo escrito ni el scroll). */

.room-grid--fs {
  /* Alturas fijas para poder apilar los tres pisos con calc() desde abajo. */
  --fs-controls-h: 3.4rem;
  --fs-emos-h: 2.6rem;
  --fs-dock-w: min(340px, 38vw);
  display: block;
  position: relative;
  width: 100%;
  height: 100%;
  gap: 0;
  background: #000;
}

/* Respaldo para el iPhone, que no deja poner un contenedor HTML a pantalla
   completa: se ocupa la ventana desde dentro de la propia página. */
.room-grid--cinema {
  position: fixed;
  inset: 0;
  z-index: 90;
}

.room-grid--fs .video-stage { position: absolute; inset: 0; }

.room-grid--fs .player { height: 100%; }

.room-grid--fs video {
  width: 100%;
  height: 100%;
  max-height: none;
  border-radius: 0;
  box-shadow: none;
  object-fit: contain;
}

.room-grid--fs .controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: var(--fs-controls-h);
  margin: 0;
  padding: 0 0.9rem;
  /* Una fila única con scroll si no cabe. No es cosmético: así la altura es
     fija y conocida, y el chat puede apilarse encima con calc() en vez de con
     desplazamientos a ojo que se rompen en cuanto los controles envuelven. */
  flex-wrap: nowrap;
  overflow-x: auto;
  background: linear-gradient(to top, oklch(0% 0 0 / 0.8), transparent);
}

.room-grid--fs .reactions-bar {
  position: absolute;
  right: 1rem;
  bottom: calc(var(--fs-controls-h) + 0.5rem);
  width: var(--fs-dock-w);
  height: var(--fs-emos-h);
  margin: 0;
  padding: 0 0.4rem;
  align-items: center;
  flex-wrap: nowrap;
  overflow-x: auto;
  /* Fondo opaco y NADA de backdrop-filter: un filtro aquí convertiría esta
     barra en bloque contenedor de sus descendientes `position: fixed`, y el
     modal de emojis —que se renderiza dentro— quedaría atrapado y recortado
     dentro de una tira de 2,6 rem. Además, el glassmorphism decorativo es una
     anti-referencia declarada del proyecto (.impeccable.md). */
  background: oklch(15% 0.014 65 / 0.94);
  border: 1px solid color-mix(in oklab, var(--marquee) 20%, transparent);
  border-top: none;
  border-radius: 0 0 12px 12px;
}

/* El panel y la barra son hermanos en el DOM, pero encajados se leen como una
   sola pieza flotante. */
.room-grid--fs .chat-panel {
  position: absolute;
  right: 1rem;
  bottom: calc(var(--fs-controls-h) + var(--fs-emos-h) + 0.5rem);
  width: var(--fs-dock-w);
  max-height: min(60vh, 420px);
  overflow: hidden;
  /* Mismo motivo que en la barra: sin backdrop-filter, para no atrapar aquí
     dentro al buscador de GIFs ni a ningún descendiente posicionado. */
  background: oklch(15% 0.014 65 / 0.94);
  border-color: color-mix(in oklab, var(--marquee) 20%, transparent);
  border-bottom: none;
  border-radius: 12px 12px 0 0;
}

/* El panel es flex column con overflow oculto, así que la lista de mensajes
   cede alto (flex:1 + min-height:0) y el buscador de GIFs cabe entero en vez
   de quedar cortado por debajo del borde. */
.room-grid--fs .chat-entries {
  min-height: 0;
  max-height: none;
}

.room-grid--fs .gif-picker { flex-shrink: 0; }

.room-grid--fs .gif-grid { max-height: 32vh; }

.room-grid--fs .controls,
.room-grid--fs .reactions-bar,
.room-grid--fs .chat-panel {
  transition: opacity 0.35s var(--ease-out);
}

/* El chrome se retira solo tras unos segundos sin actividad. El
   .reaction-overlay se queda FUERA de la regla a propósito: los emojis volando
   son justo lo que se quiere ver con la sala a oscuras. */
.room-grid--fs.is-idle { cursor: none; }

.room-grid--fs.is-idle .controls,
.room-grid--fs.is-idle .reactions-bar,
.room-grid--fs.is-idle .chat-panel {
  opacity: 0;
  pointer-events: none;
}
```

- [ ] **Step 2: Desactivar la transición con movimiento reducido**

Dentro del bloque `@media (prefers-reduced-motion: reduce)`, junto a las demás reglas de `transition: none`, añade:

```css
  .room-grid--fs .controls,
  .room-grid--fs .reactions-bar,
  .room-grid--fs .chat-panel { transition: none; }
```

- [ ] **Step 3: Verificar a ojo**

Run: arranca la app, entra en una sala y pulsa el botón de pantalla completa.
Expected:
1. El vídeo llena la pantalla sin recortes ni bandas raras (`object-fit: contain`).
2. Los controles quedan superpuestos abajo, en **una sola fila**, sobre un degradado.
3. El chat flota abajo a la derecha con fondo translúcido, y la barra de reacciones queda pegada justo debajo, encajada con él como una pieza única.
4. El chat se puede leer, escribir y hacer scroll; el buscador de GIFs y el modal de emojis se abren y se ven.
5. Los emojis siguen volando sobre el vídeo.
6. Al salir, la maquetación normal vuelve exactamente como estaba, **con el texto a medio escribir en el chat todavía ahí**.

- [ ] **Step 4: Commit**

```bash
git add web/src/theme.css
git commit -m "feat: maquetación de pantalla completa con el chat flotante"
```

---

## Task 12: El chrome se oculta solo y despierta con los mensajes

**Files:**
- Create: `web/src/player/useIdleChrome.ts`
- Modify: `web/src/pages/Room.tsx`

**Interfaces:**
- Consumes: `isTypingTarget` (Task 8), la clase `is-idle` (Task 11).
- Produces: `useIdleChrome({ enabled, container, isBlocked, idleMs? }): { awake: boolean; wake: () => void }`.

- [ ] **Step 1: Escribir el hook**

Crea `web/src/player/useIdleChrome.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

const IDLE_MS = 3000

// Retira controles, chat flotante y barra de reacciones tras un rato sin
// actividad, y los devuelve a la primera señal de vida. Solo se arma en
// pantalla completa: fuera de ella el chrome se ve siempre.
export function useIdleChrome({
  enabled, container, isBlocked, idleMs = IDLE_MS,
}: {
  enabled: boolean
  container: RefObject<HTMLElement | null>
  // Devuelve true cuando el chrome NO puede irse todavía (se está escribiendo,
  // o la sala está en pausa). Es una función y no un booleano para que el
  // temporizador consulte el valor del momento en que vence, no el de cuando
  // se armó.
  isBlocked: () => boolean
  idleMs?: number
}): { awake: boolean; wake: () => void } {
  const [awake, setAwake] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const isBlockedRef = useRef(isBlocked)
  isBlockedRef.current = isBlocked

  const wake = useCallback(() => {
    setAwake(true)
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    if (!enabledRef.current) return
    const sleep = () => {
      if (isBlockedRef.current()) { timerRef.current = setTimeout(sleep, idleMs); return }
      timerRef.current = null
      setAwake(false)
    }
    timerRef.current = setTimeout(sleep, idleMs)
  }, [idleMs])

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null }
      setAwake(true)
      return
    }
    const el = container.current
    wake()
    // El teclado va en `window` y no en el contenedor: en pantalla completa el
    // foco puede estar en el <body>, que no es descendiente del contenedor a
    // efectos de burbujeo de teclas.
    window.addEventListener('keydown', wake)
    el?.addEventListener('pointermove', wake)
    el?.addEventListener('pointerdown', wake)
    el?.addEventListener('focusin', wake)
    return () => {
      if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null }
      window.removeEventListener('keydown', wake)
      el?.removeEventListener('pointermove', wake)
      el?.removeEventListener('pointerdown', wake)
      el?.removeEventListener('focusin', wake)
    }
  }, [enabled, container, wake])

  return { awake, wake }
}
```

- [ ] **Step 2: Conectarlo en Room**

En `web/src/pages/Room.tsx`, añade el import:

```ts
import { useIdleChrome } from '../player/useIdleChrome'
import { isTypingTarget } from '../player/format'
```

Justo después de la línea del `useFullscreen`, añade:

```tsx
  // El temporizador consulta esto al vencer: con la sala en pausa o con alguien
  // escribiendo, el chrome no se va.
  const pausedRef = useRef(true)
  pausedRef.current = lastState?.state.paused ?? true
  const { awake: chromeAwake, wake: wakeChrome } = useIdleChrome({
    enabled: fullscreen,
    container: gridRef,
    isBlocked: () => {
      if (pausedRef.current) return true
      const el = document.activeElement as HTMLElement | null
      return isTypingTarget(el?.tagName, (el as HTMLInputElement | null)?.type, el?.isContentEditable)
    },
  })

  // Un mensaje nuevo despierta el chrome sin necesidad de tocar el ratón. Los
  // de sistema («X pausó») no cuentan: son ruido, no conversación. La primera
  // pasada se ignora para que el historial que llega en el `welcome` no cuente
  // como mensaje nuevo.
  const lastEntryRef = useRef<string | null>(null)
  useEffect(() => {
    const last = chat.entries.at(-1)
    const previous = lastEntryRef.current
    lastEntryRef.current = last?.id ?? null
    if (!last || previous === null || last.id === previous) return
    if (last.kind === 'system') return
    wakeChrome()
  }, [chat.entries, wakeChrome])
```

Este bloque debe ir **después** de la declaración de `lastState` y de `chat` (líneas 47 y 61), y antes del primer `return` condicional.

Y añade la clase `is-idle` al contenedor:

```tsx
      <div ref={gridRef} className={`room-grid${fullscreen ? ' room-grid--fs' : ''}${cinema ? ' room-grid--cinema' : ''}${fullscreen && !chromeAwake ? ' is-idle' : ''}`}>
```

- [ ] **Step 3: Verificar tipos y tests**

Run: `cd web && npx tsc --noEmit && cd .. && npm test`
Expected: sin errores; todos los tests pasan.

- [ ] **Step 4: Verificar a ojo**

Run: arranca la app con dos pestañas en la misma sala, dale al play y pon una a pantalla completa.
Expected:
1. Con la película en marcha y sin tocar nada, a los ~3 s desaparecen controles, chat y reacciones, y el cursor se oculta.
2. Mover el ratón los devuelve al instante.
3. **Manda un mensaje desde la otra pestaña sin tocar el ratón en la primera:** el chrome reaparece solo.
4. Un mensaje de sistema (pausar desde la otra pestaña) **no** lo despierta por sí mismo — aunque al pausar el chrome se queda visible de todos modos, que es lo que se busca.
5. Con el cursor dentro del input del chat y escribiendo, el chrome no se va nunca.
6. Con la sala en pausa, el chrome no se va.
7. Al salir de pantalla completa todo vuelve a verse siempre.

- [ ] **Step 5: Commit**

```bash
git add web/src/player/useIdleChrome.ts web/src/pages/Room.tsx
git commit -m "feat: el chrome de pantalla completa se oculta solo y despierta con los mensajes"
```

---

## Task 13: Documentación

**Files:**
- Modify: `docs/e2e-checklist.md`
- Modify: `README.md:171-174` y sección «Desarrollo»

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: nada de código.

- [ ] **Step 1: Ampliar el checklist E2E**

Añade al final de `docs/e2e-checklist.md`:

```markdown
## Reacciones y emojis
- [ ] Al pulsar un emoji, aparece pequeño junto al nombre de quien lo pulsó, en
      TODAS las pestañas, y desaparece a los ~2,5 s
- [ ] Pulsar dos emojis seguidos reinicia el destello con el segundo
- [ ] Dos invitados con el MISMO nombre: el destello cae en el chip correcto
- [ ] El botón «+» abre el modal; el catálogo carga y se ve la rejilla
- [ ] Buscar «palomitas» encuentra 🍿; buscar «corazon» sin tilde encuentra corazones
- [ ] Añadir un emoji lo pone al final de la barra y lo deshabilita en la rejilla
- [ ] La ✕ de un chip lo quita de la barra
- [ ] Al llegar a 12 sale el aviso y la rejilla se deshabilita entera
- [ ] Recargar la página conserva la selección; otro navegador tiene la suya

## Pantalla completa
- [ ] El botón de los controles entra y sale de pantalla completa
- [ ] La tecla F entra y sale; escribir una «f» en el chat NO la dispara
- [ ] Doble clic en el vídeo entra y sale SIN dejar dos mensajes de sistema
- [ ] Escape sale de pantalla completa
- [ ] El vídeo llena la pantalla sin recortes; los controles quedan superpuestos
      abajo en una sola fila
- [ ] El chat flota abajo a la derecha, encajado con la barra de reacciones
- [ ] Se puede escribir y hacer scroll en el chat flotante; el buscador de GIFs
      y el modal de emojis se abren y se ven
- [ ] Tras ~3 s sin tocar nada, controles/chat/reacciones se ocultan y el cursor
      desaparece; los emojis volando siguen viéndose
- [ ] Un mensaje de otra pestaña despierta el chrome SIN tocar el ratón
- [ ] Con el foco en el input del chat, el chrome no se oculta nunca
- [ ] Con la sala en pausa, el chrome no se oculta
- [ ] Escribir algo a medias, entrar y salir de pantalla completa: el texto SIGUE ahí
- [ ] En iPhone el botón activa el «modo cine» (ocupa la ventana, con la barra
      de Safari a la vista) y el chat flotante se ve
```

- [ ] **Step 2: Actualizar el README**

En `README.md`, sustituye la sección «Reacciones» (líneas 171-174) por:

```markdown
### Reacciones
- Barra de emojis rápidos, personalizable por espectador
- El botón «+» abre un selector con el catálogo completo en español y buscador
- La selección se guarda en el navegador (hasta 12 emojis)
- Los emojis flotan subiendo sobre el vídeo en ambas pantallas (estilo Instagram Live)
- El emoji aparece además, pequeño y durante unos segundos, junto al nombre de
  quien lo mandó en la lista de participantes
- No aparecen en el historial del chat
```

Y añade en la sección «Desarrollo», después de «Verificación de tipos»:

```markdown
### Regenerar el catálogo de emojis

```bash
node web/scripts/gen-emoji-catalog.mjs
```

Reescribe `web/src/chat/emojiCatalog.ts` desde emojibase-data en español.
Solo hace falta cuando Unicode saca emojis nuevos. Necesita red, y por eso
queda fuera del build y de los tests.
```

También añade a la sección «Características del chat», o donde encaje mejor,
una mención a la pantalla completa:

```markdown
### Pantalla completa
- Botón en los controles, doble clic sobre el vídeo o tecla `F`
- El chat y las reacciones flotan abajo a la derecha sobre el vídeo
- Todo se oculta tras unos segundos sin actividad y vuelve al mover el ratón o
  al llegar un mensaje
- En iPhone, donde el navegador no permite pantalla completa con overlays, se
  usa un «modo cine» que ocupa la ventana
```

- [ ] **Step 3: Pasada final completa**

Run: `npm test && cd server && npx tsc --noEmit && cd ../web && npx tsc --noEmit && cd ..`
Expected: todos los tests pasan y no hay errores de tipos en ninguno de los dos paquetes.

- [ ] **Step 4: Commit**

```bash
git add docs/e2e-checklist.md README.md
git commit -m "docs: reacciones personalizables, destello y pantalla completa"
```
