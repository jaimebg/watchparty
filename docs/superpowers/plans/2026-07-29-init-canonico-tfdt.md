# Init fMP4 canónico y `tfdt` absoluto — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un salto de posición aterrice donde dice la playlist aunque ffmpeg se haya reiniciado, y devolver el seek a la interfaz como barra arrastrable para todos los espectadores.

**Architecture:** Un módulo puro nuevo (`server/src/media/fmp4.ts`) edita cajas MP4 en memoria. `TranscodeSession` lo usa en dos sitios: al fijar el snapshot del init le quita el `edts` (donde ffmpeg guarda *dónde arrancó ese run*) y se queda con los timescales; al servir cada segmento desplaza el `tfdt` al instante absoluto que la playlist ya declara. Así la línea de tiempo la fija el servidor, no el proceso de ffmpeg que casualmente produjera cada archivo.

**Tech Stack:** TypeScript ESM, Node 20+, vitest, ffmpeg-static/ffprobe-static, React 18.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-init-canonico-tfdt-design.md`.
- Los commits van **directos a `main`**, sin rama por cambio.
- Comentarios y mensajes de UI en español, como el resto del repo. Los comentarios explican **por qué**, no qué.
- Tests del servidor: `npm test -w server` (vitest, `testTimeout: 60_000`). Tests del web: `npm test -w web`.
- Typecheck del servidor: `npm run typecheck -w server`.
- Los tests que lanzan ffmpeg real llevan timeout explícito por `it(...)` (patrón existente: `90_000`).
- Imports internos con extensión `.js` (ESM), como todo el repo.
- **No tocar** la lógica existente de `requestInit` que espera a que el init esté entero (`segFreshEnough`, escritura por tmp + rename, guardas de `closed`): sigue siendo necesaria y ya está cubierta por tests.

## File Structure

**Se crea:**
- `server/src/media/fmp4.ts` — edición de cajas MP4 en memoria. Sin I/O, sin estado. Único sitio que sabe de offsets de `mvhd`/`tkhd`/`mdhd`/`tfdt`/`sidx`.
- `server/test/fmp4.test.ts` — unitarios de lo anterior, con bytes construidos a mano.

**Se modifica:**
- `server/src/media/transcoder.ts` — `requestInit` canonicaliza; `openSegment` nuevo.
- `server/src/rooms/roomManager.ts:15-23` — `SessionLike` gana `openSegment`.
- `server/src/http/api.ts:125-133` — la ruta de segmento usa `openSegment`.
- `server/test/transcoder.test.ts` — dos tests existentes pasan a medir sobre `openSegment`, y dos nuevos (init byte-idéntico, y el cruce init-de-un-run/segmento-de-otro) reproducen el fallo real.
- `server/test/api.test.ts:14-20`, `server/test/hub.test.ts:25`, `server/test/roomManager.test.ts:12`, `server/test/status.test.ts:14` — los cuatro dobles de `SessionLike` ganan `openSegment`.
- `web/src/player/format.ts` — `clampPosition` y `positionGradient`.
- `web/test/format.test.ts` — sus tests.
- `web/src/player/Player.tsx` — barra arrastrable, sin gate de host.
- `web/src/pages/Room.tsx:237` — deja de pasar `isHost` a `Player`.
- `web/src/theme.css:639-655` — `.progress`/`.progress-fill` fuera, `.seek.position` dentro.
- `README.md`, `docs/e2e-checklist.md`.

**Desvío deliberado respecto al spec:** el spec preveía un
`server/test/fmp4.integration.test.ts` aparte. Los tests con ffmpeg real
necesitan una `TranscodeSession` y la fixture MKV que `transcoder.test.ts` ya
monta en su `beforeAll` (30 s de vídeo, ~4 s por generación), así que van ahí en
vez de duplicar el montaje. `fmp4.test.ts` se queda solo con lo unitario.

---

### Task 1: Lectura de cajas MP4 y `headerLength`

La base de todo: recorrer las cajas de un buffer y localizar dónde empieza el `mdat`. Lo delicado es que `headerLength` trabaja sobre un buffer **parcial** (los primeros 64 KB de un segmento de megas), así que no puede exigir que la caja `mdat` quepa entera.

**Files:**
- Create: `server/src/media/fmp4.ts`
- Test: `server/test/fmp4.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `interface Box { type: string; start: number; hdr: number; size: number }`, `parseBoxes(buf: Buffer, start?: number, end?: number): Box[]`, `headerLength(buf: Buffer): number`.

- [ ] **Step 1: Escribir el test que falla**

Crea `server/test/fmp4.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseBoxes, headerLength } from '../src/media/fmp4.js'

// Construye una caja MP4: [size:4][type:4][payload]
function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + payload.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

describe('parseBoxes', () => {
  it('lista las cajas de nivel superior con su offset y tamaño', () => {
    const buf = Buffer.concat([box('ftyp', Buffer.alloc(4)), box('moov', Buffer.alloc(16))])
    expect(parseBoxes(buf)).toEqual([
      { type: 'ftyp', start: 0, hdr: 8, size: 12 },
      { type: 'moov', start: 12, hdr: 8, size: 24 },
    ])
  })

  it('recorre solo el rango pedido, para bajar a los hijos de un contenedor', () => {
    const inner = Buffer.concat([box('mvhd', Buffer.alloc(4))])
    const buf = box('moov', inner)
    const [moov] = parseBoxes(buf)
    expect(parseBoxes(buf, moov.start + moov.hdr, moov.start + moov.size).map(b => b.type)).toEqual(['mvhd'])
  })

  it('entiende el tamaño de 64 bits (size==1)', () => {
    const buf = Buffer.alloc(20)
    buf.writeUInt32BE(1, 0)
    buf.write('mdat', 4, 'latin1')
    buf.writeBigUInt64BE(20n, 8)
    expect(parseBoxes(buf)).toEqual([{ type: 'mdat', start: 0, hdr: 16, size: 20 }])
  })

  it('para en seco ante una caja que se sale del buffer en vez de leer basura', () => {
    const truncated = box('moov', Buffer.alloc(40)).subarray(0, 20)
    expect(parseBoxes(truncated)).toEqual([])
  })
})

describe('headerLength', () => {
  it('devuelve el offset del mdat', () => {
    // styp=8, sidx=8+8=16, moof=8+4=12 → el mdat empieza en 36.
    const buf = Buffer.concat([box('styp'), box('sidx', Buffer.alloc(8)), box('moof', Buffer.alloc(4)), box('mdat', Buffer.alloc(9))])
    expect(headerLength(buf)).toBe(36)
  })

  it('encuentra el mdat aunque su contenido NO quepa en el buffer', () => {
    // Es el caso real: se leen 64 KB de un segmento de megas, así que el mdat
    // declara un tamaño que se sale del buffer. Si se exigiera que la caja
    // entera quepa, nunca se encontraría la cabecera.
    const head = Buffer.concat([box('styp'), box('moof', Buffer.alloc(4))])
    const mdat = Buffer.alloc(8)
    mdat.writeUInt32BE(5_000_000, 0)
    mdat.write('mdat', 4, 'latin1')
    expect(headerLength(Buffer.concat([head, mdat]))).toBe(head.length)
  })

  it('devuelve -1 si el mdat no aparece dentro del buffer', () => {
    expect(headerLength(Buffer.concat([box('styp'), box('sidx', Buffer.alloc(8))]))).toBe(-1)
  })
})
```

- [ ] **Step 2: Ejecutar el test y verificar que falla**

Run: `npm test -w server -- fmp4`
Expected: FAIL — `Failed to resolve import "../src/media/fmp4.js"`.

- [ ] **Step 3: Escribir la implementación mínima**

Crea `server/src/media/fmp4.ts`:

```ts
// Edición de cajas MP4 en memoria. Sin I/O y sin estado: es el único sitio del
// servidor que sabe de offsets dentro de un fMP4, para que transcoder.ts pueda
// hablar de «init canónico» y «tiempo absoluto» sin contar bytes.

export interface Box { type: string; start: number; hdr: number; size: number }

/**
 * Cajas de un rango del buffer, sin descender a los hijos. Ante una caja
 * incoherente (tamaño menor que su cabecera, o que se sale del rango) para en
 * seco: preferimos una lista corta a leer basura como si fuera estructura.
 */
export function parseBoxes(buf: Buffer, start = 0, end = buf.length): Box[] {
  const out: Box[] = []
  let p = start
  while (p + 8 <= end) {
    const declared = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    let hdr = 8
    let size = declared
    if (declared === 1) {
      if (p + 16 > end) break
      size = Number(buf.readBigUInt64BE(p + 8))
      hdr = 16
    } else if (declared === 0) {
      size = end - p
    }
    if (size < hdr || p + size > end) break
    out.push({ type, start: p, hdr, size })
    p += size
  }
  return out
}

/**
 * Offset donde empieza el `mdat` de un segmento, o -1 si no aparece.
 *
 * Pensado para un buffer PARCIAL: el `mdat` de un segmento de 4 s son megas, así
 * que su tamaño declarado casi nunca cabe en la cabecera que leemos. Por eso
 * comprueba el tipo ANTES de validar que la caja quepa entera, al revés que
 * parseBoxes.
 */
export function headerLength(buf: Buffer): number {
  let p = 0
  while (p + 8 <= buf.length) {
    const declared = buf.readUInt32BE(p)
    if (buf.toString('latin1', p + 4, p + 8) === 'mdat') return p
    let hdr = 8
    let size = declared
    if (declared === 1) {
      if (p + 16 > buf.length) return -1
      size = Number(buf.readBigUInt64BE(p + 8))
      hdr = 16
    } else if (declared === 0) {
      return -1
    }
    if (size < hdr || p + size > buf.length) return -1
    p += size
  }
  return -1
}
```

- [ ] **Step 4: Ejecutar el test y verificar que pasa**

Run: `npm test -w server -- fmp4`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/media/fmp4.ts server/test/fmp4.test.ts
git commit -m "feat: lectura de cajas fMP4 y localización del mdat"
```

---

### Task 2: `canonicalizeInit`

Quita el `edts` de cada pista (donde ffmpeg guarda el offset del `-ss`, medido: `dur=20000` ms al reiniciar en 20 s) y pone a 0 las duraciones, para que el init salga **idéntico venga del run que venga**. De paso devuelve los timescales, que hacen falta para retimear.

**Files:**
- Modify: `server/src/media/fmp4.ts`
- Test: `server/test/fmp4.test.ts`

**Interfaces:**
- Consumes: `parseBoxes` (Task 1).
- Produces: `canonicalizeInit(raw: Buffer): { init: Buffer; timescales: Map<number, number> }` — el mapa va de `trackID` a `mdhd.timescale`.

- [ ] **Step 1: Escribir el test que falla**

En `server/test/fmp4.test.ts`, amplía el import que ya existe a
`import { parseBoxes, headerLength, canonicalizeInit } from '../src/media/fmp4.js'`
y añade lo siguiente al final (el helper `box` ya está definido arriba):

```ts
// version(1)+flags(3), creation(4), modification(4), timescale(4), duration(4)
function mvhd(timescale: number, duration: number): Buffer {
  const p = Buffer.alloc(100)
  p.writeUInt32BE(timescale, 12)
  p.writeUInt32BE(duration, 16)
  return box('mvhd', p)
}

// version(1)+flags(3), creation(4), modification(4), trackID(4), reserved(4), duration(4)
function tkhd(trackId: number, duration: number): Buffer {
  const p = Buffer.alloc(80)
  p.writeUInt32BE(trackId, 12)
  p.writeUInt32BE(duration, 20)
  return box('tkhd', p)
}

// version(1)+flags(3), creation(4), modification(4), timescale(4), duration(4)
function mdhd(timescale: number, duration: number): Buffer {
  const p = Buffer.alloc(20)
  p.writeUInt32BE(timescale, 12)
  p.writeUInt32BE(duration, 16)
  return box('mdhd', p)
}

// elst con un empty edit (media_time = -1): lo que ffmpeg escribe tras un -ss.
function edts(emptyEditDuration: number): Buffer {
  const p = Buffer.alloc(16)
  p.writeUInt32BE(1, 4)                 // entry_count
  p.writeUInt32BE(emptyEditDuration, 8) // segment_duration
  p.writeInt32BE(-1, 12)                // media_time
  return box('edts', box('elst', p))
}

const trak = (id: number, ts: number) =>
  box('trak', Buffer.concat([tkhd(id, 4000), edts(20000), box('mdia', mdhd(ts, 4000))]))

const fakeInit = () => Buffer.concat([
  box('ftyp', Buffer.alloc(8)),
  box('moov', Buffer.concat([mvhd(1000, 4000), trak(1, 12800), trak(2, 44100)])),
])

describe('canonicalizeInit', () => {
  it('quita el edts de cada pista y arregla los tamaños de trak y moov', () => {
    const { init } = canonicalizeInit(fakeInit())
    const moov = parseBoxes(init).find(b => b.type === 'moov')!
    const traks = parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    expect(traks).toHaveLength(2)
    for (const t of traks) {
      expect(parseBoxes(init, t.start + t.hdr, t.start + t.size).map(b => b.type)).toEqual(['tkhd', 'mdia'])
    }
    // Los tamaños tienen que cuadrar de verdad: si moov mintiera, parseBoxes
    // del nivel superior no llegaría hasta el final del buffer.
    expect(parseBoxes(init).map(b => b.type)).toEqual(['ftyp', 'moov'])
    expect(moov.start + moov.size).toBe(init.length)
  })

  it('devuelve el timescale de cada pista', () => {
    expect([...canonicalizeInit(fakeInit()).timescales]).toEqual([[1, 12800], [2, 44100]])
  })

  it('pone a cero las duraciones, para que dos runs distintos den el mismo init', () => {
    const desde0 = canonicalizeInit(fakeInit()).init
    // Un run reiniciado codifica menos metraje: otras duraciones y otro empty edit.
    const otro = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.concat([
        mvhd(1000, 999), box('trak', Buffer.concat([tkhd(1, 111), edts(77), box('mdia', mdhd(12800, 111))])),
        box('trak', Buffer.concat([tkhd(2, 222), edts(88), box('mdia', mdhd(44100, 222))])),
      ])),
    ])
    expect(canonicalizeInit(otro).init.equals(desde0)).toBe(true)
  })

  it('no toca el buffer de entrada', () => {
    const raw = fakeInit()
    const copia = Buffer.from(raw)
    canonicalizeInit(raw)
    expect(raw.equals(copia)).toBe(true)
  })

  it('es idempotente: canonicalizar un init ya canónico no lo cambia', () => {
    const una = canonicalizeInit(fakeInit()).init
    expect(canonicalizeInit(una).init.equals(una)).toBe(true)
  })
})
```

- [ ] **Step 2: Ejecutar el test y verificar que falla**

Run: `npm test -w server -- fmp4`
Expected: FAIL — `canonicalizeInit is not a function` (o error de import).

- [ ] **Step 3: Escribir la implementación mínima**

Añade a `server/src/media/fmp4.ts`:

```ts
export interface CanonicalInit { init: Buffer; timescales: Map<number, number> }

// Contenedores que hay que reconstruir para poder tirar un hijo: al quitar el
// `edts` cambia el tamaño de su `trak` y, en cascada, el del `moov`.
const REBUILD_PARENTS = new Set(['moov', 'trak', 'mdia'])

function rebuildWithout(buf: Buffer, start: number, end: number, drop: string): Buffer {
  const parts: Buffer[] = []
  for (const b of parseBoxes(buf, start, end)) {
    if (b.type === drop) continue
    if (!REBUILD_PARENTS.has(b.type)) {
      parts.push(buf.subarray(b.start, b.start + b.size))
      continue
    }
    const kids = rebuildWithout(buf, b.start + b.hdr, b.start + b.size, drop)
    const head = Buffer.from(buf.subarray(b.start, b.start + b.hdr))
    const total = b.hdr + kids.length
    if (b.hdr === 16) head.writeBigUInt64BE(BigInt(total), 8)
    else head.writeUInt32BE(total, 0)
    parts.push(head, kids)
  }
  return Buffer.concat(parts)
}

// mvhd/tkhd/mdhd comparten prólogo (creation, modification) pero tkhd mete
// track_id y un reservado antes de la duración; y la v1 usa 64 bits para las
// fechas y la duración. Offsets contados desde el final de version+flags.
function durationOffset(type: string, version: number): number {
  if (type === 'tkhd') return version === 1 ? 28 : 20
  return version === 1 ? 24 : 16
}

function zeroDuration(buf: Buffer, b: Box): void {
  const version = buf[b.start + b.hdr]
  const at = b.start + b.hdr + durationOffset(b.type, version)
  if (version === 1) buf.writeBigUInt64BE(0n, at)
  else buf.writeUInt32BE(0, at)
}

// `track_id` en tkhd y `timescale` en mdhd caen en el mismo offset: tras el
// prólogo de fechas, que es lo único que cambia entre v0 y v1.
function readAfterDates(buf: Buffer, b: Box): number {
  const version = buf[b.start + b.hdr]
  return buf.readUInt32BE(b.start + b.hdr + (version === 1 ? 20 : 12))
}

/**
 * Init reproducible: sin `edts` y con las duraciones a cero.
 *
 * ffmpeg guarda en el `edts` de cada pista un «empty edit» con la posición
 * absoluta donde arrancó ese proceso (medido: dur=20000 ms al reiniciar con
 * `-ss 20`). Como el servidor fija UN snapshot del init para toda la sala, ese
 * offset acabaría aplicándose a segmentos de cualquier otro reinicio. Sin
 * `edts`, la línea de tiempo sale solo del `tfdt`, que sí controlamos
 * (retimeHeader). Las duraciones se ponen a cero por la misma razón: un run
 * reiniciado codifica menos metraje y las escribiría distintas.
 */
export function canonicalizeInit(raw: Buffer): CanonicalInit {
  // Buffer.concat copia, así que `init` es propio y se puede mutar sin tocar `raw`.
  const init = rebuildWithout(raw, 0, raw.length, 'edts')
  const timescales = new Map<number, number>()
  const moov = parseBoxes(init).find(b => b.type === 'moov')
  if (!moov) throw new Error('init de fMP4 sin moov')
  for (const b of parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size)) {
    if (b.type === 'mvhd') zeroDuration(init, b)
    if (b.type !== 'trak') continue
    let trackId = 0
    for (const t of parseBoxes(init, b.start + b.hdr, b.start + b.size)) {
      // tkhd va antes que mdia dentro de trak, así que para cuando se lee el
      // timescale el trackId ya está puesto.
      if (t.type === 'tkhd') { trackId = readAfterDates(init, t); zeroDuration(init, t) }
      if (t.type !== 'mdia') continue
      for (const m of parseBoxes(init, t.start + t.hdr, t.start + t.size)) {
        if (m.type !== 'mdhd') continue
        timescales.set(trackId, readAfterDates(init, m))
        zeroDuration(init, m)
      }
    }
  }
  return { init, timescales }
}
```

- [ ] **Step 4: Ejecutar el test y verificar que pasa**

Run: `npm test -w server -- fmp4`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/media/fmp4.ts server/test/fmp4.test.ts
git commit -m "feat: init de fMP4 canónico, sin el edts que ancla el run al -ss"
```

---

### Task 3: `retimeHeader`

Desplaza la cabecera de un segmento al instante absoluto que la playlist ya declara.

**Files:**
- Modify: `server/src/media/fmp4.ts`
- Test: `server/test/fmp4.test.ts`

**Interfaces:**
- Consumes: `parseBoxes` (Task 1).
- Produces: `retimeHeader(head: Buffer, timescales: Map<number, number>, startSec: number): Buffer`.

- [ ] **Step 1: Escribir el test que falla**

En `server/test/fmp4.test.ts`, añade `retimeHeader` al import que ya existe y
mete lo siguiente al final:

```ts
// tfdt v1: version(1)+flags(3), baseMediaDecodeTime(8)
function tfdt(base: number): Buffer {
  const p = Buffer.alloc(12)
  p.writeUInt8(1, 0)
  p.writeBigUInt64BE(BigInt(base), 4)
  return box('tfdt', p)
}

// tfhd: version(1)+flags(3), track_ID(4)
function tfhd(trackId: number): Buffer {
  const p = Buffer.alloc(8)
  p.writeUInt32BE(trackId, 4)
  return box('tfhd', p)
}

// sidx v1: version(1)+flags(3), reference_ID(4), timescale(4), earliestPT(8), firstOffset(8)
function sidx(trackId: number, timescale: number, earliest: number): Buffer {
  const p = Buffer.alloc(28)
  p.writeUInt8(1, 0)
  p.writeUInt32BE(trackId, 4)
  p.writeUInt32BE(timescale, 8)
  p.writeBigUInt64BE(BigInt(earliest), 12)
  return box('sidx', p)
}

const readTfdt = (buf: Buffer, nth = 0) =>
  Number(buf.readBigUInt64BE(parseBoxes(buf).filter(b => b.type === 'moof')
    .flatMap(m => parseBoxes(buf, m.start + m.hdr, m.start + m.size))
    .flatMap(t => parseBoxes(buf, t.start + t.hdr, t.start + t.size))
    .filter(b => b.type === 'tfdt')[nth].start + 12))

const readSidx = (buf: Buffer, nth = 0) =>
  Number(buf.readBigUInt64BE(parseBoxes(buf).filter(b => b.type === 'sidx')[nth].start + 20))

const SCALES = new Map([[1, 12800], [2, 44100]])

// Cabecera como la que escribe ffmpeg: styp, un sidx por pista, y un moof con
// un traf por pista. Un run reiniciado la escribe con los tfdt a cero.
const head = (videoBase: number, audioBase: number) => Buffer.concat([
  box('styp', Buffer.alloc(8)),
  sidx(1, 12800, videoBase),
  sidx(2, 44100, audioBase),
  box('moof', Buffer.concat([
    box('mfhd', Buffer.alloc(8)),
    box('traf', Buffer.concat([tfhd(1), tfdt(videoBase)])),
    box('traf', Buffer.concat([tfhd(2), tfdt(audioBase)])),
  ])),
])

describe('retimeHeader', () => {
  it('lleva el tfdt de cada pista a start × su propio timescale', () => {
    const out = retimeHeader(head(0, 0), SCALES, 20)
    expect(readTfdt(out, 0)).toBe(20 * 12800)
    expect(readTfdt(out, 1)).toBe(20 * 44100)
  })

  it('mueve también el earliest_presentation_time del sidx', () => {
    const out = retimeHeader(head(0, 0), SCALES, 20)
    expect(readSidx(out, 0)).toBe(20 * 12800)
    expect(readSidx(out, 1)).toBe(20 * 44100)
  })

  it('desplaza, no fija: un segundo fragmento conserva su separación', () => {
    const dos = Buffer.concat([
      head(0, 0),
      box('moof', Buffer.concat([
        box('mfhd', Buffer.alloc(8)),
        box('traf', Buffer.concat([tfhd(1), tfdt(2 * 12800)])),
        box('traf', Buffer.concat([tfhd(2), tfdt(2 * 44100)])),
      ])),
    ])
    const out = retimeHeader(dos, SCALES, 20)
    expect(readTfdt(out, 2)).toBe(22 * 12800)
    expect(readTfdt(out, 3)).toBe(22 * 44100)
  })

  it('funciona igual con un run que ya traía tiempos absolutos', () => {
    const out = retimeHeader(head(8 * 12800, 8 * 44100), SCALES, 20)
    expect(readTfdt(out, 0)).toBe(20 * 12800)
    expect(readTfdt(out, 1)).toBe(20 * 44100)
  })

  it('no cambia el tamaño del buffer ni toca la entrada', () => {
    const entrada = head(0, 0)
    const copia = Buffer.from(entrada)
    const out = retimeHeader(entrada, SCALES, 20)
    expect(out.length).toBe(entrada.length)
    expect(entrada.equals(copia)).toBe(true)
  })

  it('deja intacta una pista de la que no conoce el timescale', () => {
    const out = retimeHeader(head(0, 0), new Map([[1, 12800]]), 20)
    expect(readTfdt(out, 0)).toBe(20 * 12800)
    expect(readTfdt(out, 1)).toBe(0)
    expect(readSidx(out, 1)).toBe(0)
  })
})
```

- [ ] **Step 2: Ejecutar el test y verificar que falla**

Run: `npm test -w server -- fmp4`
Expected: FAIL — `retimeHeader is not a function`.

- [ ] **Step 3: Escribir la implementación mínima**

Añade a `server/src/media/fmp4.ts`:

```ts
function readTime(buf: Buffer, at: number, version: number): number {
  return version === 1 ? Number(buf.readBigUInt64BE(at)) : buf.readUInt32BE(at)
}

// Se conserva la versión de la caja: promocionar una v0 a v1 cambiaría el
// tamaño, y con él el de todos sus padres. Desbordar los 32 bits de una v0
// exigiría ~13 h de película a timescale 90000, fuera del caso real.
function writeTime(buf: Buffer, at: number, version: number, value: number): void {
  const safe = Math.max(0, value)
  if (version === 1) buf.writeBigUInt64BE(BigInt(safe), at)
  else buf.writeUInt32BE(safe, at)
}

/**
 * Cabecera de segmento reanclada al instante absoluto que declara la playlist.
 *
 * ffmpeg numera cada reinicio desde su propio origen (medido: el `tfdt` del
 * segmento 5 vale 0 en un run que arrancó con `-ss 20`), así que el tiempo del
 * medio depende de qué proceso lo escribió. Aquí se fija por construcción.
 *
 * Desplaza en vez de fijar: el offset lo decide el PRIMER `moof` de cada pista y
 * los siguientes se mueven lo mismo, de modo que si algún día cae más de un
 * fragmento por segmento, su separación interna se conserva.
 */
export function retimeHeader(head: Buffer, timescales: Map<number, number>, startSec: number): Buffer {
  const out = Buffer.from(head)
  const deltas = new Map<number, number>()
  for (const moof of parseBoxes(out)) {
    if (moof.type !== 'moof') continue
    for (const traf of parseBoxes(out, moof.start + moof.hdr, moof.start + moof.size)) {
      if (traf.type !== 'traf') continue
      let trackId = 0
      for (const b of parseBoxes(out, traf.start + traf.hdr, traf.start + traf.size)) {
        // tfhd va antes que tfdt dentro de traf, así que el trackId ya está puesto.
        if (b.type === 'tfhd') { trackId = out.readUInt32BE(b.start + b.hdr + 4); continue }
        if (b.type !== 'tfdt') continue
        const timescale = timescales.get(trackId)
        if (timescale === undefined) continue
        const version = out[b.start + b.hdr]
        const at = b.start + b.hdr + 4
        const current = readTime(out, at, version)
        if (!deltas.has(trackId)) deltas.set(trackId, Math.round(startSec * timescale) - current)
        writeTime(out, at, version, current + deltas.get(trackId)!)
      }
    }
  }
  // Segunda pasada: el sidx va ANTES del moof en el archivo, pero su
  // desplazamiento sale del moof, así que no se puede resolver en la primera.
  for (const b of parseBoxes(out)) {
    if (b.type !== 'sidx') continue
    const delta = deltas.get(out.readUInt32BE(b.start + b.hdr + 4))
    if (delta === undefined) continue
    const version = out[b.start + b.hdr]
    const at = b.start + b.hdr + 12
    writeTime(out, at, version, readTime(out, at, version) + delta)
  }
  return out
}
```

- [ ] **Step 4: Ejecutar el test y verificar que pasa**

Run: `npm test -w server -- fmp4`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/media/fmp4.ts server/test/fmp4.test.ts
git commit -m "feat: reanclar la cabecera de un segmento al tiempo absoluto de la playlist"
```

---

### Task 4: Init canónico y segmento anclado

Las dos mitades del arreglo van juntas porque están acopladas: canonicalizar el
init sin retimear deja el segmento de un run reiniciado en 0, y retimear sin
canonicalizar suma el offset dos veces (el `elst` y el `tfdt`). Cualquiera de las
dos a solas rompe los tests de timestamp que ya existen; juntas los dejan más
exactos. Un solo commit.

**Files:**
- Modify: `server/src/media/transcoder.ts`
- Test: `server/test/transcoder.test.ts`

**Interfaces:**
- Consumes: `canonicalizeInit`, `headerLength`, `retimeHeader`, `parseBoxes` (Tasks 1-3).
- Produces:
  - `TranscodeSession.requestInit(variant, timeoutMs?)` → `Promise<string>` — misma firma, ahora el archivo apuntado es canónico.
  - `TranscodeSession.openSegment(variant: number, index: number, timeoutMs?: number): Promise<Readable>`.

- [ ] **Step 1: Escribir los tests que fallan**

En `server/test/transcoder.test.ts` añade estos imports arriba del archivo:

```ts
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { parseBoxes } from '../src/media/fmp4.js'
```

Y estos dos helpers, antes del `describe`:

```ts
async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

// start_time de cada pista de un fMP4, que solo es reproducible con su init
// delante. Es la medida que importa: es donde hls.js coloca el segmento.
async function startTimes(dir: string, init: Buffer, seg: Buffer): Promise<number[]> {
  const joined = join(dir, `joined-${randomBytes(4).toString('hex')}.mp4`)
  writeFileSync(joined, Buffer.concat([init, seg]))
  const { stdout } = await run(ffprobeStatic.path, [
    '-v', 'error', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', joined,
  ])
  return stdout.trim().split('\n').map(Number)
}
```

Y los dos tests, dentro del `describe('TranscodeSession', ...)`:

```ts
  it('el init entregado es canónico y no depende del run que lo produjo', async () => {
    // El fallo de bb67bc0: ffmpeg guarda en el edts del init la posición donde
    // arrancó ESE proceso, y el servidor fija un init para toda la sala. Si el
    // init recuerda su run, los segmentos de cualquier otro reinicio se colocan
    // en el offset equivocado.
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const paths: string[] = []
    for (const [name, from] of [['desde0', 0], ['mid', mid]] as const) {
      const dir = mkdtempSync(join(tmpdir(), `tsc-canon-${name}-`))
      const out = join(dir, 'out'); mkdirSync(out)
      // audioCount 1 → una sola variante con el audio DENTRO del segmento de
      // vídeo (ver hlsLayout.ts), que es la forma en que corre una sala normal y
      // la única en la que el init 0 tiene dos pistas que comprobar.
      const s = new TranscodeSession({
        input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 1, outDir: out,
      })
      s.start(from)
      paths.push(await s.requestInit(0, 30_000))
      await s.stop()
    }

    const [desde0, desdeMid] = paths.map(p => readFileSync(p))
    // Ningún trak conserva edts.
    const moov = parseBoxes(desde0).find(b => b.type === 'moov')!
    for (const t of parseBoxes(desde0, moov.start + moov.hdr, moov.start + moov.size)) {
      if (t.type !== 'trak') continue
      expect(parseBoxes(desde0, t.start + t.hdr, t.start + t.size).map(b => b.type)).not.toContain('edts')
    }
    // Y los dos runs dan exactamente el mismo init.
    expect(desdeMid.equals(desde0)).toBe(true)
  }, 120_000)

  it('un segmento de un run reiniciado aterriza en su sitio con el init de OTRO run', async () => {
    // Exactamente el fallo reportado en bb67bc0: la sala arranca en 0, fija ese
    // init, el host salta a mitad de película y ffmpeg reinicia. Medido antes de
    // este arreglo: el segmento decodificaba en 0:00:00 en vez de en su minuto.
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)

    const dirA = mkdtempSync(join(tmpdir(), 'tsc-open-a-'))
    const outA = join(dirA, 'out'); mkdirSync(outA)
    // audioCount 1 → el audio va dentro del segmento de vídeo, así que
    // startTimes() devuelve las dos pistas y de paso comprueba el lipsync.
    const a = new TranscodeSession({
      input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 1, outDir: outA,
    })
    a.start(0)
    const initFijado = readFileSync(await a.requestInit(0, 30_000))
    await a.stop()

    const dirB = mkdtempSync(join(tmpdir(), 'tsc-open-b-'))
    const outB = join(dirB, 'out'); mkdirSync(outB)
    const b = new TranscodeSession({
      input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 1, outDir: outB,
    })
    b.start(mid)
    const seg = await drain(await b.openSegment(0, mid, 30_000))
    await b.stop()

    // El init es el del run A y el segmento el del run B: es el cruce que rompía.
    const times = await startTimes(dirB, initFijado, seg)
    expect(times).toHaveLength(2) // vídeo y audio, los dos dentro del segmento
    for (const t of times) {
      expect(Math.abs(t - segments[mid].start)).toBeLessThan(0.05)
    }
  }, 120_000)
```

- [ ] **Step 2: Ejecutar los tests y verificar que fallan**

Run: `npm test -w server -- transcoder -t "canónico"` y `npm test -w server -- transcoder -t "aterriza en su sitio"`
Expected: el primero FALLA porque el init aún trae `edts`; el segundo FALLA con `b.openSegment is not a function`.

- [ ] **Step 3: Canonicalizar el init al fijarlo**

En `server/src/media/transcoder.ts`, cambia el import de `node:fs` y añade los nuevos:

```ts
import { createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { PassThrough, Readable } from 'node:stream'
import { canonicalizeInit, headerLength, retimeHeader } from './fmp4.js'
```

(`copyFileSync` deja de usarse: el snapshot ya no es una copia byte a byte sino el init canonicalizado.)

Añade una constante junto a `FORWARD_GRACE_MS`:

```ts
// Cuánto se lee de un segmento para encontrar y parchear su cabecera. Medido en
// un segmento de 4 s: styp+sidx+sidx+moof ocupan ~2,5 KB, así que 64 KB sobran
// de largo; si aun así no apareciera el mdat, se relee el archivo entero.
const HEAD_PROBE_BYTES = 64 * 1024
```

Añade el campo, junto a `initCopies`:

```ts
  // Timescale de cada pista, por variante, sacado del init al fijarlo. Hace
  // falta para retimear los segmentos, y no se puede deducir del plan: cada
  // pista tiene el suyo (medido: vídeo 12800, audio 44100).
  private timescales = new Map<number, Map<number, number>>()
```

En `requestInit`, la línea del `stable`:

```ts
    const stable = join(this.opts.outDir, `init_${variant}.stable.mp4`)
    if (existsSync(stable)) { this.loadTimescales(variant, stable); return stable }
```

y, dentro del `while`, el bloque que copiaba:

```ts
      if (existsSync(live) && (this.finished || this.segFreshEnough(this.segPath(variant, this.startSegment)))) {
        const { init, timescales } = canonicalizeInit(readFileSync(live))
        const tmp = `${stable}.${this.initCopies++}.tmp`
        writeFileSync(tmp, init)
        renameSync(tmp, stable)
        this.timescales.set(variant, timescales)
        return stable
      }
```

Y debajo de `requestInit`:

```ts
  // Un snapshot que ya existía (misma sesión, otra variante ya servida) no pasó
  // por el set de arriba. canonicalizeInit es idempotente sobre un init ya
  // canónico, así que releerlo es la forma barata de recuperar sus timescales.
  private loadTimescales(variant: number, stable: string): void {
    if (this.timescales.has(variant)) return
    this.timescales.set(variant, canonicalizeInit(readFileSync(stable)).timescales)
  }
```

- [ ] **Step 4: Implementar `openSegment`**

Tras `requestSegment`, en la misma clase:

```ts
  /**
   * El segmento listo para servir: los mismos bytes que escribió ffmpeg pero con
   * la cabecera reanclada al instante que la playlist declara para ese índice.
   *
   * Solo la cabecera pasa por memoria; el `mdat` (megas) sigue viajando en
   * streaming desde disco.
   */
  async openSegment(variant: number, index: number, timeoutMs = 30_000): Promise<Readable> {
    const path = await this.requestSegment(variant, index, timeoutMs)
    // Garantiza que el init está fijado, que es de donde salen los timescales.
    await this.requestInit(variant, timeoutMs)
    const timescales = this.timescales.get(variant)
    const start = this.segments[index]?.start
    if (!timescales || start === undefined) return createReadStream(path)

    const fh = await open(path, 'r')
    let head: Buffer
    let headLen: number
    try {
      const size = (await fh.stat()).size
      let probe = Buffer.alloc(Math.min(HEAD_PROBE_BYTES, size))
      await fh.read(probe, 0, probe.length, 0)
      headLen = headerLength(probe)
      if (headLen < 0 && probe.length < size) {
        probe = Buffer.alloc(size)
        await fh.read(probe, 0, size, 0)
        headLen = headerLength(probe)
      }
      // Sin `mdat` no hay segmento: servirlo tal cual sería resucitar el fallo
      // en silencio, así que se prefiere el 504 que ya devuelve la ruta.
      if (headLen < 0) throw new Error(`Segmento sin mdat v${variant}#${index}`)
      head = retimeHeader(probe.subarray(0, headLen), timescales, start)
    } finally {
      await fh.close()
    }

    const out = new PassThrough()
    out.write(head)
    const rest = createReadStream(path, { start: headLen })
    rest.on('error', e => out.destroy(e))
    rest.pipe(out)
    return out
  }
```

- [ ] **Step 5: Poner al día los dos tests de timestamp que ya existían**

Los tests `'a segment produced by a mid-film start carries the correct absolute timestamp'` (≈línea 190) y su gemelo de transcode (≈línea 217) miden sobre `requestSegment`, que entrega los bytes tal cual salen de ffmpeg. Con el init ya canónico, esos bytes arrancan en 0: hay que medir sobre `openSegment`, que es lo que sirve el servidor. Cambia en **ambos**:

```ts
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
```

por:

```ts
    const seg = await drain(await s.openSegment(0, mid, 30_000))
    const init = readFileSync(await s.requestInit(0, 30_000))

    // openSegment ancla el segmento al límite que declara la playlist, así que
    // el margen deja de ser «casi» y pasa a ser exacto salvo redondeo.
    const [video] = await startTimes(dir, init, seg)
    expect(Math.abs(video - segments[mid].start)).toBeLessThan(0.05)
```

- [ ] **Step 6: Ejecutar toda la suite del transcoder y verificar que pasa**

Run: `npm test -w server -- transcoder && npm run typecheck -w server`
Expected: PASS, todos. Ningún test queda en rojo.

- [ ] **Step 7: Commit**

```bash
git add server/src/media/transcoder.ts server/test/transcoder.test.ts
git commit -m "fix: fijar la línea de tiempo en el servidor, no heredarla de ffmpeg

El edts que ffmpeg escribe tras un -ss guarda la posición donde arrancó ese
proceso, y el tfdt del segmento vuelve a 0. Como requestInit fija un snapshot
para toda la vida de la sala, ese offset se aplicaba a segmentos de cualquier
otro reinicio: medido, un segmento de mitad de película decodificaba en 0:00:00.

Las dos mitades van juntas porque están acopladas: canonicalizar el init sin
retimear deja el segmento en 0, y retimear sin canonicalizar suma el offset dos
veces. requestInit entrega ahora un init sin edts (byte-idéntico venga del run
que venga) y openSegment reancla la cabecera al instante que declara la
playlist, dejando el mdat en streaming desde disco.

El test nuevo cruza a propósito el init de un run desde 0 con un segmento de un
run desde mitad de película, que es lo que pasaba en la sala."
```

---


### Task 5: La ruta HTTP sirve el segmento retimeado

**Files:**
- Modify: `server/src/http/api.ts:125-133`
- Modify: `server/src/rooms/roomManager.ts:15-23`
- Test: `server/test/api.test.ts`

**Interfaces:**
- Consumes: `openSegment` (Task 4).
- Produces: `SessionLike.openSegment(variant: number, index: number, timeoutMs?: number): Promise<Readable>`.

- [ ] **Step 1: Escribir el test que falla**

En `server/test/api.test.ts`, añade `openSegment` al `fakeSession` (líneas 14-20):

```ts
const fakeSession = {
  start: () => {}, seekTo: () => {}, stop: async () => {}, onError: () => {}, lastLog: [] as string[],
  requestSegment: vi.fn(async (_v: number, _i: number) => {
    const p = join(process.env.JBG_DATA_DIR!, 'fake.m4s'); writeFileSync(p, 'seg'); return p
  }),
  openSegment: vi.fn(async (_v: number, _i: number) => Readable.from([Buffer.from('seg-retimed')])),
  requestInit: vi.fn(async () => { throw new Error('sin init') }),
}
```

con `import { Readable } from 'node:stream'` arriba. Cambia los tres `requestSegment` de los tests de rutas (líneas ≈215, ≈218, ≈248, ≈252) por `openSegment`, y añade:

```ts
  it('el segmento se sirve por openSegment, que es quien lo ancla en el tiempo', async () => {
    const s = await app.inject({ url: `/stream/${token}/seg_0_00000.m4s` })
    expect(s.statusCode).toBe(200)
    expect(s.body).toBe('seg-retimed')
    expect(fakeSession.openSegment).toHaveBeenCalledWith(0, 0)
  })
```

- [ ] **Step 2: Ejecutar el test y verificar que falla**

Run: `npm test -w server -- api -t "openSegment"`
Expected: FAIL — el body sigue siendo `seg` (la ruta usa `requestSegment`).

- [ ] **Step 3: Escribir la implementación mínima**

En `server/src/rooms/roomManager.ts`, dentro de `SessionLike` (líneas 15-23), añade junto a `requestSegment`:

```ts
  // Los bytes listos para servir: requestSegment da la ruta del archivo tal cual
  // lo escribió ffmpeg, y openSegment lo ancla en el tiempo de la playlist.
  openSegment(variant: number, index: number, timeoutMs?: number): Promise<Readable>
```

con `import type { Readable } from 'node:stream'` arriba del archivo.

En `server/src/http/api.ts`, en el bloque `seg` (líneas 125-133):

```ts
      try {
        return reply.type('video/mp4').send(await room.session.openSegment(variant, Number(seg[2])))
      } catch { return reply.code(504).send() }
```

y quita `createReadStream` del import de `node:fs` si ya no se usa en el archivo (la ruta del init sí lo sigue usando: compruébalo antes de tocarlo).

- [ ] **Step 4: Poner al día los otros tres dobles de `SessionLike`**

`openSegment` es obligatorio en la interfaz, así que los tres dobles que quedan
dejan de compilar. En los tres basta con devolver un stream vacío: ninguno de
esos tests sirve bytes de vídeo.

En `server/test/hub.test.ts:25`, junto a `requestSegment`:

```ts
    openSegment: async () => Readable.from([]),
```

En `server/test/roomManager.test.ts:12`, junto a `requestSegment`:

```ts
  openSegment: async () => Readable.from([]),
```

En `server/test/status.test.ts:14`, dentro del objeto literal del `createSession`:

```ts
openSegment: async () => Readable.from([]),
```

Los tres necesitan `import { Readable } from 'node:stream'` arriba del archivo.

- [ ] **Step 5: Ejecutar los tests y el typecheck**

Run: `npm test -w server && npm run typecheck -w server`
Expected: PASS todo.

- [ ] **Step 6: Commit**

```bash
git add server/src/http/api.ts server/src/rooms/roomManager.ts server/test/api.test.ts \
  server/test/hub.test.ts server/test/roomManager.test.ts server/test/status.test.ts
git commit -m "fix: la ruta de segmento sirve los bytes anclados, no el archivo crudo"
```

---

### Task 6: Helpers puros de la barra de posición

Los tests del web son de lógica pura (no hay jsdom ni testing-library), así que lo que se puede probar del slider se extrae a `format.ts`, como ya se hizo con `volumeGradient`.

**Files:**
- Modify: `web/src/player/format.ts`
- Test: `web/test/format.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `clampPosition(value: number, durationSec: number): number`, `positionGradient(position: number, durationSec: number): string`.

- [ ] **Step 1: Escribir el test que falla**

En `web/test/format.test.ts`, amplía el import que ya existe (no añadas una
segunda línea del mismo módulo):

```ts
import { clampPosition, formatClock, parseClock, parseStoredVolume, positionGradient, spaceBelongsTo, volumeGradient } from '../src/player/format'
```

Y añade al final:

```ts
describe('clampPosition', () => {
  it('recorta al metraje real por los dos lados', () => {
    expect(clampPosition(-5, 100)).toBe(0)
    expect(clampPosition(500, 100)).toBe(100)
    expect(clampPosition(42, 100)).toBe(42)
  })

  it('un valor no finito vale 0, no un NaN que viaje por el socket', () => {
    expect(clampPosition(NaN, 100)).toBe(0)
    expect(clampPosition(Infinity, 100)).toBe(100)
  })

  it('con duración desconocida (0) no deja pasar posiciones inventadas', () => {
    expect(clampPosition(42, 0)).toBe(0)
  })
})

describe('positionGradient', () => {
  it('pinta el relleno hasta el porcentaje visto', () => {
    expect(positionGradient(25, 100)).toBe(
      'linear-gradient(90deg, var(--seek-fill) 25%, var(--seek-track) 25%)')
  })

  it('sin duración conocida no rellena nada', () => {
    expect(positionGradient(10, 0)).toBe(
      'linear-gradient(90deg, var(--seek-fill) 0%, var(--seek-track) 0%)')
  })
})
```

- [ ] **Step 2: Ejecutar el test y verificar que falla**

Run: `npm test -w web -- format`
Expected: FAIL — `clampPosition is not a function`.

- [ ] **Step 3: Escribir la implementación mínima**

Añade a `web/src/player/format.ts`:

```ts
// Un salto pedido desde la barra, recortado al metraje real antes de viajar por
// el socket. El servidor también recorta, pero mandar un valor de fuera de rango
// haría que la sala saltara a un sitio distinto del que soltó el pulgar.
export function clampPosition(value: number, durationSec: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), Math.max(0, durationSec))
}

// Relleno de la barra de posición. Un input[type=range] no admite un hijo que
// haga de relleno, así que se pinta con un degradado de fondo, igual que el
// slider de volumen.
export function positionGradient(position: number, durationSec: number): string {
  const pct = durationSec > 0 ? (clampPosition(position, durationSec) / durationSec) * 100 : 0
  return `linear-gradient(90deg, var(--seek-fill) ${pct}%, var(--seek-track) ${pct}%)`
}
```

- [ ] **Step 4: Ejecutar el test y verificar que pasa**

Run: `npm test -w web -- format`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/player/format.ts web/test/format.test.ts
git commit -m "feat: helpers de la barra de posición (recorte y relleno)"
```

---

### Task 7: Barra arrastrable, para todos

**Files:**
- Modify: `web/src/player/Player.tsx` (props, estado de arrastre, líneas ≈257-262 y ≈299-314)
- Modify: `web/src/pages/Room.tsx:237`
- Modify: `web/src/theme.css:639-655`

**Interfaces:**
- Consumes: `clampPosition`, `positionGradient` (Task 6).
- Produces: `Player` deja de aceptar el prop `isHost`.

- [ ] **Step 1: Quitar el prop `isHost` de `Player`**

En `web/src/player/Player.tsx` líneas 35-37, borra `isHost` de la desestructuración y del tipo. En `web/src/pages/Room.tsx:237`, borra `isHost={isHost}` de la llamada (el `useState` de `isHost` en la línea 62 **se queda**: lo usa el botón de copiar enlace).

- [ ] **Step 2: Añadir el estado de arrastre**

En `Player.tsx`, junto a los demás `useState` (≈línea 58):

```ts
  // Valor que enseña la barra mientras se arrastra. Sin esto, el tick de 500 ms
  // del reloj de sala reescribe la posición bajo el pulgar y el thumb se escapa.
  const [drag, setDrag] = useState<number | null>(null)
  const draggingRef = useRef(false)
```

Y, junto al efecto de `welcomeCount` (≈línea 92):

```ts
  // Al soltar, la barra se queda donde la dejó el pulgar hasta que llega el
  // estado nuevo: devolverla antes al valor viejo del reloj de sala daría un
  // salto atrás visible durante el viaje de ida y vuelta. Mientras el pulgar
  // siga abajo no se toca.
  useEffect(() => { if (!draggingRef.current) setDrag(null) }, [lastState])
```

- [ ] **Step 3: Sustituir la barra de solo lectura**

Cambia el comentario y el cálculo de las líneas ≈257-262:

```ts
  const roomPosition = lastState
    ? Math.min(info.durationSec, targetPosition(lastState.state, lastState.serverNow, lastState.receivedAt, Date.now()))
    : 0
  const shownPosition = drag ?? roomPosition
  const remaining = Math.max(0, info.durationSec - shownPosition)

  const commitSeek = () => {
    draggingRef.current = false
    if (drag === null) return
    sendRef.current({ t: 'seek', position: clampPosition(drag, info.durationSec) })
  }
```

Y sustituye el `<div className="progress">…</div>` (líneas ≈299-303) por:

```tsx
        <input className="seek position" type="range" step={1}
          min={0} max={Math.max(1, Math.round(info.durationSec))}
          aria-label="Posición en la película"
          aria-valuetext={`${formatClock(shownPosition)} de ${formatClock(info.durationSec)}`}
          style={{ background: positionGradient(shownPosition, info.durationSec) }}
          value={Math.round(shownPosition)}
          onPointerDown={() => { draggingRef.current = true }}
          onChange={e => setDrag(Number(e.target.value))}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek} />
```

Actualiza el import de `format`:

```ts
import { clampPosition, formatClock, MAX_VOLUME, parseClock, parseStoredVolume, positionGradient, spaceBelongsTo, volumeGradient } from './format'
```

- [ ] **Step 4: Quitar el gate de host del formulario «Ir a»**

En la línea ≈305, cambia `{isHost && (` … `)}` por el formulario suelto, sin condición:

```tsx
        <form className="jump-group" onSubmit={e => { e.preventDefault(); jump() }}>
          <label className="jump-label" htmlFor="jump-to">Ir a</label>
          <input id="jump-to" className="jump-input" value={jumpTo} placeholder="1:27:00"
            aria-label="Saltar a un momento de la película"
            aria-invalid={jumpError !== null}
            onChange={e => { setJumpTo(e.target.value); setJumpError(null) }} />
          <button type="submit" className="btn-jump" disabled={jumpTo.trim() === ''}>Saltar</button>
        </form>
```

- [ ] **Step 5: Ajustar el CSS**

En `web/src/theme.css`, borra el comentario de la línea 639 y las reglas `.progress` y `.progress-fill` (líneas 641-655), y añade tras el bloque `.seek`:

```css
/* La barra de posición ocupa el hueco entre los dos relojes; el relleno lo pinta
   positionGradient() en el fondo, porque un input[type=range] no admite hijos. */
.seek.position {
  flex: 1;
  min-width: 120px;
}
```

- [ ] **Step 6: Verificar build y tests**

Run: `npm test -w web && npm run build -w web`
Expected: PASS y build limpio. Si el build se queja de `isHost` sin usar en `Room.tsx`, comprueba que el botón de copiar enlace lo sigue usando; si de verdad quedó huérfano, quita también su `useState`.

- [ ] **Step 7: Commit**

```bash
git add web/src/player/Player.tsx web/src/pages/Room.tsx web/src/theme.css
git commit -m "feat: la barra vuelve a ser arrastrable, y el seek deja de ser solo del host

El handler de seek del servidor nunca tuvo puerta de host: validaba, recortaba,
reiniciaba ffmpeg y difundía igual viniera de quien viniera. La restricción era
solo del cliente, y play/pausa ya era de todos.

Mientras el pulgar está abajo la barra enseña su propio valor: el tick de 500 ms
del reloj de sala se lo llevaría por delante."
```

---

### Task 8: Documentación

**Files:**
- Modify: `docs/e2e-checklist.md`
- Modify: `README.md`

- [ ] **Step 1: Actualizar el checklist E2E**

En `docs/e2e-checklist.md`, sección «Sync», sustituye la línea del campo «Ir a» solo para el host y añade los casos que cubren este arreglo:

```markdown
- [ ] La barra de posición se arrastra y la sala salta al soltar (no en cada píxel)
- [ ] «Ir a» y la barra están disponibles para el invitado, no solo para el host
- [ ] «Ir a 1:27:00» desde cualquiera → ambos saltan; vídeo arranca en < 10 s
- [ ] Saltar, esperar a que arranque, y saltar OTRA VEZ a una zona nueva → el
      vídeo aparece en el minuto pedido (antes salía el principio de la película)
- [ ] Tras dos o tres saltos seguidos, imagen y sonido siguen en sincronía
```

- [ ] **Step 2: Actualizar el README**

En `README.md`, sección «Códecs de vídeo», justo después del párrafo que acaba en
`` `server/src/media/hlsLayout.ts`. `` (≈línea 144), añade:

```markdown
  Además, el servidor fija la línea de tiempo del medio en vez de heredarla de
  ffmpeg: sirve un init canónico (sin el *edit list* donde ffmpeg guarda en qué
  punto arrancó ese proceso) y ancla la cabecera de cada segmento al instante que
  la playlist ya declara. Sin eso, un salto de posición solo aterrizaba bien
  mientras la sala siguiera corriendo sobre el ffmpeg que produjo el primer init.
  La edición de cajas MP4 vive en `server/src/media/fmp4.ts`.
```

Y en el bloque «Estructura del proyecto» (≈línea 244), cambia la línea de `media/`:

```markdown
│   │   ├── media/             # Probe, planificación de segmentos, ffmpeg, cajas MP4, subtítulos, caché
```

- [ ] **Step 3: Verificar la suite completa**

Run: `npm test`
Expected: PASS, servidor y web.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/e2e-checklist.md
git commit -m "docs: el seek ya es fiable tras un reinicio, y no es solo del host"
```

---

## Verificación final (manual, no automatizable)

Los tests miden `start_time` con ffprobe, que es la señal correcta pero no prueba
que hls.js lo coloque bien en un navegador real. Antes de dar el trabajo por
cerrado, con una película de verdad:

1. `npm start`, crear sala, dejar que arranque desde 0.
2. Saltar a mitad de película. Debe aparecer imagen en el minuto pedido.
3. **Saltar otra vez** a un tercer punto. Es el caso que fallaba: el init ya está
   fijado del primer run y los segmentos vienen de un tercer proceso.
4. Comprobar el lipsync tras los saltos.
5. Repetir desde una segunda pestaña como invitado, comprobando que también
   puede arrastrar la barra y que la sala sigue a los dos.
