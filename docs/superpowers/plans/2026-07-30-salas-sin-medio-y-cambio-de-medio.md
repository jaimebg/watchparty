# Salas sin película y cambio de película en caliente — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el host pueda crear una sala sin película y cambiar la película dentro de la sala, recalculando duración, pistas de audio, subtítulos y metadatos sin que nadie recargue ni pierda el chat.

**Architecture:** `Room` se parte en identidad de sala (token, chat, estado, listeners) y `RoomMedia | null` (item, info, segments, subtitles, meta, session, dir). Cada película es un `epoch` incremental con su propio subdirectorio de caché y su propio prefijo de URL (`/stream/<token>/e<n>/…`), de modo que ni la caché HTTP ni el relevo puedan servir bytes de la película anterior. El cambio se difunde por WebSocket como `{t:'media', epoch}` y el cliente refetchea `GET /api/rooms/:token` y remonta el `<Player>` por `key`.

**Tech Stack:** Node 20+, TypeScript (ESM, `"type": "module"`), Fastify 5 + `@fastify/websocket` + `@fastify/cookie`, React 18 + Vite, hls.js 1.6, Vitest, ffmpeg/ffprobe estáticos.

**Spec:** `docs/superpowers/specs/2026-07-30-salas-sin-medio-y-cambio-de-medio-design.md`

## Global Constraints

- **Comentarios y textos de UI en castellano.** Los comentarios explican *por qué*, no *qué*. Los mensajes de error y la copia visible van en castellano.
- **Los tests prueban funciones puras y endpoints con `app.inject`, nunca componentes React.** El comportamiento que solo se puede comprobar en navegador va a `docs/e2e-checklist.md`.
- **Los commits van directos a `main`.** No se crean ramas.
- **Verificación obligatoria antes de cada commit:** `npx tsc --noEmit` en el workspace tocado (ambos si tocas los dos) y los tests de ese workspace. Nunca se afirma que algo pasa sin haber visto la salida.
- **`npm test` = `npm run test -w server && npm run test -w web`.** Los tests de `server` generan fixtures con ffmpeg de verdad: tardan ~1 min, es normal.
- **No hay dependencia cruzada entre workspaces:** `web/src/types.ts` es un espejo **manual** de los tipos del server. Todo cambio en `server/src/ws/messages.ts` o en la respuesta de `GET /api/rooms/:token` se copia a mano.
- **Solo el host cambia la película.** `POST /api/rooms/:token/media` lleva `preHandler: requireAdmin`. Play/pausa/seek siguen siendo de todos.
- **No se toca la autenticación de `POST /api/rooms/:token/retry`.** Es un agujero preexistente y está fuera de alcance.
- **`streamBase` vive al nivel superior de `RoomInfo`**, nunca dentro de `media`: describe dónde vive el servidor, no la película.

---

## Estructura de ficheros

**Server — se modifican:**
- `server/src/library/scanner.ts` — añade `folderPath` a `LibraryItem` y agrupa los `readdir` por directorio (Tarea 1).
- `server/src/rooms/roomManager.ts` — el split `Room`/`RoomMedia`, `create(item?)`, `setMedia`, `RoomBusyError` (Tareas 2 y 3).
- `server/src/http/api.ts` — endpoint de medio, rutas de `/stream` versionadas, forma nueva de `GET /api/rooms/:token` (Tarea 4).
- `server/src/ws/messages.ts` — `{t:'media'}` (Tarea 5).
- `server/src/ws/hub.ts` — `mediaListeners`, guardas sin película, re-attach de `stallControl` (Tarea 5).
- `server/src/index.ts` — la poda de caché lee `r.media.dir` (Tarea 2).

**Server — NO se tocan:** `media/planner.ts`, `media/ffmpegArgs.ts`, `media/transcoder.ts`, `media/hlsLayout.ts`, `media/probe.ts`, `media/subtitles.ts`, `media/tmdb.ts`, `rooms/stallControl.ts`, `rooms/syncState.ts`, `http/security.ts`. El epoch en el path hace que `planner.ts` no necesite saber que existe.

**Web — se crean:**
- `web/src/MediaPicker.tsx` — modal de selección de película (Tarea 8).

**Web — se modifican:**
- `web/src/types.ts` — `RoomMediaInfo`, `RoomInfo`, `ServerMsg` (Tarea 6).
- `web/src/api.ts` — `createRoom` opcional, `setRoomMedia`, `rescanLibrary` (Tarea 6).
- `web/src/player/streamUrl.ts` — el epoch en el path (Tarea 6).
- `web/src/player/Player.tsx` — prop `media` + `streamBase` (Tarea 6).
- `web/src/pages/Room.tsx` — estado de sala vacía, `isHost`, refetch, `key={epoch}` (Tarea 7).
- `web/src/pages/Library.tsx` — botón de sala vacía, agrupación por `folderPath` (Tarea 9).
- `web/src/theme.css` — estilos del picker y del cartel de espera (Tarea 8).

**Docs:** `docs/e2e-checklist.md` y `README.md` (Tarea 10).

**Orden de dependencias:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Las tareas 2 y 3 son el corazón; 4 y 5 dependen de la forma que fija la 3; 6 depende de la forma de respuesta que fija la 4.

---

### Task 1: Scanner — `folderPath` y un `readdir` por directorio

**Files:**
- Modify: `server/src/library/scanner.ts:6` (tipo), `server/src/library/scanner.ts:20-37` (`scanLibrary`)
- Test: `server/test/scanner.test.ts`
- Test: `server/test/scannerReads.test.ts` (nuevo — aislado porque `vi.mock` es hoisted y afecta al fichero entero)

**Interfaces:**
- Consumes: nada.
- Produces: `interface LibraryItem { id: string; path: string; title: string; folderName: string; folderPath: string; srtFiles: string[] }`. `folderPath` es el `dirname` absoluto ya resuelto; `folderName` sigue siendo `basename(dir)`.

**Por qué:** `walk` es recursivo pero `folderName` es solo el basename, así que dos carpetas homónimas (`…/Alien/Season 1` y `…/Dune/Season 1`) se fusionan en una sola sección de UI con los episodios mezclados. Y el emparejado de `.srt` hace un `readdir` **por cada vídeo**: con 200 episodios en una carpeta son 200 lecturas del mismo directorio. Hasta ahora eso solo pasaba en la portada; a partir de la Tarea 8 pasa al abrir el picker con la sala ya en marcha.

- [ ] **Step 1: Escribir los tests que fallan**

Añade estos tres casos a `server/test/scanner.test.ts`, dentro del `describe('scanLibrary', …)` existente:

```ts
  // basename() a solas fusiona dos carpetas distintas que se llamen igual, y en
  // una biblioteca real («Season 1» de dos series) eso mezcla episodios de ambas
  // bajo una sola cabecera sin forma de distinguirlos.
  it('distingue dos carpetas homónimas por su ruta completa', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-dup-'))
    mkdirSync(join(root, 'Alien', 'Season 1'), { recursive: true })
    mkdirSync(join(root, 'Dune', 'Season 1'), { recursive: true })
    writeFileSync(join(root, 'Alien', 'Season 1', 'Alien.S01E01.mkv'), '')
    writeFileSync(join(root, 'Dune', 'Season 1', 'Dune.S01E01.mkv'), '')

    const items = await scanLibrary([root])
    expect(items).toHaveLength(2)
    expect(new Set(items.map(i => i.folderName))).toEqual(new Set(['Season 1']))
    expect(new Set(items.map(i => i.folderPath)).size).toBe(2)
    expect(items.every(i => i.folderPath.endsWith(join('Season 1')))).toBe(true)
  })

  it('empareja los .srt hermanos con sufijo de idioma tras agrupar los readdir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-srt-'))
    writeFileSync(join(root, 'Peli.mkv'), '')
    writeFileSync(join(root, 'Peli.srt'), '')
    writeFileSync(join(root, 'Peli.es.srt'), '')
    writeFileSync(join(root, 'Peli.en.srt'), '')
    writeFileSync(join(root, 'Otra.mkv'), '')
    writeFileSync(join(root, 'Otra.es.srt'), '')

    const items = await scanLibrary([root])
    const peli = items.find(i => i.path.endsWith('Peli.mkv'))!
    const otra = items.find(i => i.path.endsWith('Otra.mkv'))!
    expect(peli.srtFiles).toHaveLength(3)
    expect(otra.srtFiles).toHaveLength(1)
    expect(otra.srtFiles[0]).toBe(join(root, 'Otra.es.srt'))
  })

Y añade una aserción de `folderPath` al test que ya existe, justo después de `expect(ep.folderName).toBe('Season1')`:

```ts
    expect(ep.folderPath).toBe(join(root, 'SerieX', 'Season1'))
```

- [ ] **Step 2: Escribir el test del número de lecturas, en su propio fichero**

Contar `readdir` exige interceptar el módulo, y `vi.mock` es hoisted y afecta al
fichero entero: va aparte para no mockear `node:fs/promises` en los tests de
comportamiento de arriba. Crea `server/test/scannerReads.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const reads: string[] = []

// Interceptar el módulo (y no espiar el namespace) es lo único fiable aquí: el
// escáner hace `import { readdir } from 'node:fs/promises'`, y ese binding ya
// está resuelto cuando un spy sobre el namespace llegaría.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: ((path: Parameters<typeof actual.readdir>[0], opts?: Parameters<typeof actual.readdir>[1]) => {
      reads.push(String(path))
      return actual.readdir(path as string, opts as undefined)
    }) as unknown as typeof actual.readdir,
  }
})

const { scanLibrary } = await import('../src/library/scanner.js')

describe('scanLibrary', () => {
  it('hace un readdir por directorio, no uno por vídeo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-reads-'))
    for (let i = 0; i < 8; i++) writeFileSync(join(root, `Ep${i}.mkv`), '')
    reads.length = 0

    const items = await scanLibrary([root])

    expect(items).toHaveLength(8)
    // Uno de walk() y uno para emparejar los .srt. Antes eran 1 + 8: con 200
    // episodios en una carpeta, 200 lecturas del mismo sitio.
    expect(reads.filter(p => p === root)).toHaveLength(2)
  })
})
```

- [ ] **Step 3: Ejecutar los tests para verificar que fallan**

Run: `npx vitest run test/scanner.test.ts test/scannerReads.test.ts -w server`
Expected: FAIL. Los dos de `scanner.test.ts` por `folderPath` `undefined`; el de `scannerReads.test.ts` porque hay 9 lecturas de `root` (una de `walk` + 8 de emparejado) y espera 2.

- [ ] **Step 4: Implementar el cambio**

Reemplaza el cuerpo de `server/src/library/scanner.ts` desde la línea 6 hasta el final:

```ts
export interface LibraryItem {
  id: string; path: string; title: string
  /** Nombre de la carpeta contenedora, para la etiqueta de la UI. */
  folderName: string
  /**
   * Ruta absoluta de la carpeta contenedora. Es esto y no `folderName` lo que
   * identifica un grupo: dos series pueden tener una «Season 1» cada una, y
   * agrupar por basename las fusiona en una sección con episodios de las dos.
   */
  folderPath: string
  srtFiles: string[]
}

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.webm'])

async function walk(dir: string, out: string[]): Promise<void> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (VIDEO_EXT.has(extname(e.name).toLowerCase())) out.push(p)
  }
}

export async function scanLibrary(folders: string[]): Promise<LibraryItem[]> {
  const files: string[] = []
  for (const f of folders) await walk(resolve(f), files)
  // Un solo listado por directorio, no uno por vídeo: con 200 episodios en una
  // carpeta, emparejar los .srt leyéndola cada vez son 200 lecturas del mismo
  // sitio. Y desde que se puede elegir película DENTRO de la sala, este escaneo
  // corre en mitad de la función, no solo en la portada.
  const srtByDir = new Map<string, string[]>()
  for (const dir of new Set(files.map(f => dirname(f)))) {
    const names = await readdir(dir).catch(() => [] as string[])
    srtByDir.set(dir, names.filter(n => n.endsWith('.srt')))
  }
  const items: LibraryItem[] = files.map(path => {
    const dir = dirname(path)
    const base = basename(path, extname(path))
    const siblings = (srtByDir.get(dir) ?? []).filter(n => n.startsWith(base))
    return {
      id: createHash('sha1').update(path).digest('hex'),
      path,
      title: cleanName(basename(path)),
      folderName: basename(dir),
      folderPath: dir,
      srtFiles: siblings.map(n => join(dir, n)),
    }
  })
  return items.sort((a, b) => a.folderName.localeCompare(b.folderName) || a.path.localeCompare(b.path))
}
```

- [ ] **Step 5: Ejecutar los tests para verificar que pasan**

Run: `npx vitest run test/scanner.test.ts test/scannerReads.test.ts -w server`
Expected: PASS. 3 tests en `scanner.test.ts` (el que ya existía más los dos nuevos) y 1 en `scannerReads.test.ts`.

- [ ] **Step 6: Comprobar que nada más se rompió y commitear**

Run: `cd server && npx tsc --noEmit && cd .. && npm run test -w server`
Expected: tsc sin salida, toda la suite de server en verde.

```bash
git add server/src/library/scanner.ts server/test/scanner.test.ts server/test/scannerReads.test.ts
git commit -m "refactor: el escáner identifica carpetas por ruta y agrupa los readdir"
```

---

### Task 2: Refactor puro — `Room` + `RoomMedia`, sin cambio de comportamiento

**Files:**
- Modify: `server/src/rooms/roomManager.ts:31-46` (tipos), `:63-93` (`create`), `:98-124` (`retry`), `:126-133` (`close`)
- Modify: `server/src/http/api.ts:58` (status), `:79-81` (GET room), `:100-145` (`/stream`)
- Modify: `server/src/ws/hub.ts:101-103` (seek)
- Modify: `server/src/index.ts:30` (poda de caché)
- Test: `server/test/roomManager.test.ts`, `server/test/api.test.ts:263`, `server/test/hub.test.ts:122`

**Interfaces:**
- Consumes: `LibraryItem` con `folderPath` (Tarea 1).
- Produces:
  ```ts
  export interface RoomMedia {
    epoch: number; item: LibraryItem; info: MediaInfo; segments: Segment[]
    subtitles: SubtitleOption[]; meta: RoomMeta | null; session: SessionLike
    dir: string; setBy: string | null
  }
  export interface Room {
    token: string; dir: string; media: RoomMedia
    state: PlaybackState; chat: ChatEntry[]; error: string[] | null; busy: boolean
    errorListeners: Set<(log: string[]) => void>
    closeListeners: Set<() => void>
    mediaListeners: Set<(media: RoomMedia) => void>
  }
  ```
  En esta tarea `media` es **no nulo** todavía y `create(item)` sigue exigiendo el ítem. La Tarea 3 lo pasa a `RoomMedia | null`. Separarlo así deja este commit como un renombrado mecánico revisable de un vistazo, y todas las guardas de nulo en un commit aparte.

**Por qué separado:** cambiar la forma de `Room` rompe la compilación de `api.ts`, `hub.ts` e `index.ts` en el mismo instante. Este commit hace el movimiento completo dejando la suite verde y el comportamiento idéntico; el siguiente añade la funcionalidad.

- [ ] **Step 1: Reescribir los tipos y los métodos de `RoomManager`**

En `server/src/rooms/roomManager.ts`, sustituye la interfaz `Room` (líneas 31-46) por:

```ts
/**
 * Todo lo que depende del fichero que se está viendo. Vive aparte de `Room`
 * porque una sala puede existir sin película (el host la crea y reparte el
 * enlace antes de elegir) y porque puede cambiarla sin cerrar la sala.
 */
export interface RoomMedia {
  /** 1, 2, 3… Versiona las URLs de /stream y remonta el reproductor. */
  epoch: number
  item: LibraryItem
  info: MediaInfo
  segments: Segment[]
  subtitles: SubtitleOption[]
  meta: RoomMeta | null
  session: SessionLike
  /** <cacheDir>/<token>/e<epoch> */
  dir: string
  /**
   * Nombre de quien la puso, para el mensaje de sistema. Lo aporta el navegador
   * del host: el servidor no puede saber que la cookie de admin es el
   * participante «Jaime», son dos canales distintos. null = mensaje impersonal.
   */
  setBy: string | null
}

export interface Room {
  token: string
  /** <cacheDir>/<token>. Contiene un subdirectorio por epoch. */
  dir: string
  media: RoomMedia
  state: PlaybackState
  chat: ChatEntry[]
  error: string[] | null
  /** Un cambio de película o un reintento en vuelo. Evita pisarse. */
  busy: boolean
  // TranscodeSession.onError only keeps a single callback (see transcoder.ts),
  // and RoomManager already needs that slot to record room.error. Rather than
  // fighting over the one callback, RoomManager registers its own single
  // onError handler and fans it out to whoever else wants to know (currently:
  // the ws hub, to broadcast {t:'error'} to every connected client).
  errorListeners: Set<(log: string[]) => void>
  // Notified once, synchronously, from close() before the room is torn down —
  // lets the ws hub close every live socket for the room (see hub.ts's
  // closeRoomSockets) instead of leaving zombie connections around.
  closeListeners: Set<() => void>
  /** Mismo patrón: el hub difunde el cambio de película a los clientes. */
  mediaListeners: Set<(media: RoomMedia) => void>
}
```

Sustituye `create`, `retry` y `close` (líneas 63-133) por:

```ts
  async create(item: LibraryItem): Promise<Room> {
    const token = randomBytes(16).toString('base64url')
    const dir = join(cacheDir(), token)
    const epoch = 1
    const mediaDir = join(dir, `e${epoch}`)
    mkdirSync(mediaDir, { recursive: true })
    const info = await probeFile(item.path)
    const mode = pickMode(info)
    // Solo copy corta donde diga la fuente; transcode fuerza su propia rejilla
    // de 4 s, así que ahí la lista de keyframes no solo sobra: planificar con
    // ella describiría cortes que ffmpeg no va a producir. De paso, esto ahorra
    // el volcado de paquetes de extractKeyframes (hasta 256 MB) en las salas
    // que van a transcodificar igualmente.
    const keyframes = mode === 'copy' ? await extractKeyframes(item.path) : null
    const segments = planSegments(info.durationSec, keyframes)
    const subtitles = listSubtitleOptions(info, item.srtFiles)
    for (const s of subtitles) {
      await extractSubtitle(item.path, info, item.srtFiles, s.id, join(mediaDir, `sub_${s.id}.vtt`)).catch(() => {})
    }
    const meta = this.deps.lookupMeta ? await this.deps.lookupMeta(item.title) : null
    // Pistas de audio sin idioma declarado: se infiere del nombre del archivo o
    // del idioma original (TMDB) cuando solo hay una pista.
    info.audio = enrichAudioLangs(info.audio, basename(item.path), meta?.originalLang ?? null)
    const session = this.deps.createSession(item, info, segments, mediaDir, mode)
    const room: Room = {
      token, dir,
      media: { epoch, item, info, segments, subtitles, meta, session, dir: mediaDir, setBy: null },
      state: initialState(Date.now()), chat: [], error: null, busy: false,
      errorListeners: new Set(), closeListeners: new Set(), mediaListeners: new Set(),
    }
    session.onError(log => { room.error = log; for (const cb of room.errorListeners) cb(log) })
    session.start()
    this.rooms.set(token, room)
    return room
  }

  get(token: string): Room | undefined { return this.rooms.get(token) }
  all(): Room[] { return [...this.rooms.values()] }

  async retry(token: string): Promise<void> {
    const room = this.rooms.get(token)
    if (!room) return
    const media = room.media
    await media.session.stop()
    // El set entero de segmentos de la ejecución rota no debe sobrevivir al
    // reintento: un .m4s o init_*.mp4 viejo en disco puede hacer creer a
    // requestInit() de la sesión nueva que su propio init ya está completo
    // (ver transcoder.ts) y, si el reintento pasó de copy a transcode, ese
    // init viejo trae el SPS/PPS de la fuente mientras los segmentos nuevos
    // llevan los de libx264: un desajuste de decodificador permanente. Los
    // subtítulos extraídos (sub_*.vtt) siguen siendo válidos — un reintento no
    // los regenera — así que esos se conservan.
    for (const f of readdirSync(media.dir)) {
      if (f.endsWith('.stable.mp4') || f.endsWith('.m4s') || f.startsWith('init_')) {
        rmSync(join(media.dir, f), { force: true })
      }
    }
    room.error = null
    // El reintento siempre transcodifica, y transcode fuerza keyframes cada
    // 4 s: quedarse con la rejilla de keyframes de la fuente que planificó el
    // modo copy dejaría la playlist anunciando cortes que el ffmpeg nuevo no va
    // a producir. El cliente recarga tras el retry, así que recoge la lista nueva.
    media.segments = planSegments(media.info.durationSec, null)
    media.session = this.deps.createSession(media.item, media.info, media.segments, media.dir, 'transcode')
    media.session.onError(log => { room.error = log; for (const cb of room.errorListeners) cb(log) })
    media.session.start()
  }

  async close(token: string): Promise<void> {
    const room = this.rooms.get(token)
    if (!room) return
    await room.media.session.stop()
    for (const cb of room.closeListeners) cb()
    // El directorio de la sala entero, con todos sus subdirectorios de epoch.
    rmSync(room.dir, { recursive: true, force: true })
    this.rooms.delete(token)
  }
```

- [ ] **Step 2: Actualizar los consumidores para que compile**

En `server/src/http/api.ts`:

- Línea 58 (`/api/status`): `rooms: deps.rooms.all().map(r => ({ token: r.token, title: r.media.item.title })),`
- Líneas 79-81 (`GET /api/rooms/:token`), deja el mismo contrato público de momento:
  ```ts
      const media = room.media
      return {
        title: displayTitle(media.meta, media.item.title), durationSec: media.info.durationSec,
        audio: media.info.audio, subtitles: media.subtitles, error: room.error,
        meta: media.meta,
        // Viaja aquí y no en un endpoint propio porque el cliente ya espera esta
        // respuesta antes de montar el reproductor: así no hay ni ida y vuelta
        // extra ni una ventana en la que el <video> exista sin saber su origen.
        // '' = mismo origen (ver streamBaseUrl en config.ts).
        streamBase: deps.config.streamBaseUrl ?? '',
      }
  ```
- En el handler de `/stream/:token/:file`, añade `const media = room.media` justo después del `if (!room) return reply.code(404).send()` y sustituye en todo el handler: `room.info.audio` → `media.info.audio`, `room.segments` → `media.segments`, `room.session` → `media.session`, `room.roomDir` → `media.dir`.

En `server/src/ws/hub.ts`, líneas 101-103:

```ts
            const position = Math.min(Math.max(msg.position, 0), room.media.info.durationSec)
            room.state = apply(room.state, { type: 'seek', position, at: now })
            room.media.session.seekTo(segmentForTime(room.media.segments, position))
```

En `server/src/index.ts`, línea 30:

```ts
  const files = rooms.all().flatMap(r => segmentFilesWithStats(r.media.dir))
```

- [ ] **Step 3: Migrar los tests existentes**

En `server/test/roomManager.test.ts`, sustituye todos los accesos a los campos que se movieron:

- `room.segments` → `room.media.segments` (líneas 50, 57, 66, 67, 120)
- `room.roomDir` → `room.media.dir` (líneas 76, 94, 95, 96)
- `room.session` → `room.media.session` (líneas 78, 83)

En `server/test/api.test.ts`, línea 263:

```ts
    const outOfRange = String(room.media.segments.length).padStart(5, '0')
```

En `server/test/hub.test.ts`, líneas 122 y 148:

```ts
    const duration = room.media.info.durationSec
```
```ts
    ;(room.media.session as unknown as { triggerError: (log: string[]) => void }).triggerError(['ffmpeg: boom'])
```

- [ ] **Step 4: Comprobar que compila y que la suite sigue verde**

Run: `cd server && npx tsc --noEmit && cd .. && npm run test -w server`
Expected: tsc sin salida. Toda la suite de server en verde, **con el mismo número de tests que antes**: este commit no añade comportamiento.

- [ ] **Step 5: Commit**

```bash
git add server/src/rooms/roomManager.ts server/src/http/api.ts server/src/ws/hub.ts server/src/index.ts server/test/
git commit -m "refactor: separa RoomMedia de Room sin cambiar comportamiento"
```

---

### Task 3: `RoomManager` — sala sin película, `setMedia` y `busy`

**Files:**
- Modify: `server/src/rooms/roomManager.ts`
- Modify: `server/src/http/api.ts` (guardas de nulo), `server/src/ws/hub.ts` (guardas de nulo), `server/src/index.ts` (poda)
- Test: `server/test/roomManager.test.ts`

**Interfaces:**
- Consumes: `Room`, `RoomMedia` (Tarea 2).
- Produces:
  ```ts
  export class RoomBusyError extends Error {}
  // Room.media pasa a: media: RoomMedia | null
  create(item?: LibraryItem): Promise<Room>
  setMedia(token: string, item: LibraryItem, by?: string | null): Promise<RoomMedia>
  retry(token: string): Promise<void>   // no-op si media === null; lanza RoomBusyError si busy
  ```

- [ ] **Step 1: Escribir los tests que fallan**

Añade al final de `server/test/roomManager.test.ts`:

```ts
describe('RoomManager sin película', () => {
  it('crea la sala sin tocar ffmpeg ni ffprobe', async () => {
    let sessions = 0
    const manager = new RoomManager({ createSession: () => { sessions++; return fakeSession() } })

    const room = await manager.create()

    expect(room.media).toBeNull()
    expect(sessions).toBe(0)
    expect(room.state.paused).toBe(true)
    expect(room.state.positionBase).toBe(0)
    expect(existsSync(room.dir)).toBe(true)
  })

  it('setMedia puebla info, segmentos, subtítulos y metadatos, y arranca en epoch 1', async () => {
    const meta = { title: 'Peli', year: 2020, overview: '', posterUrl: null, rating: null, episodeTag: null, originalLang: 'en' }
    const manager = new RoomManager({ createSession: () => fakeSession(), lookupMeta: async () => meta })
    const room = await manager.create()

    const media = await manager.setMedia(room.token, items[0], 'Jaime')

    expect(media.epoch).toBe(1)
    expect(media.setBy).toBe('Jaime')
    expect(media.info.audio).toHaveLength(2)
    expect(media.segments.map(s => s.start)).toEqual([0, 4, 8])
    expect(media.subtitles.length).toBeGreaterThanOrEqual(1)
    expect(media.meta).toEqual(meta)
    expect(room.media).toBe(media)
    // Todo lo de la película vive en el directorio del epoch, no en la raíz de
    // la sala: es lo que permite tirar la generación anterior de un rmSync.
    expect(media.dir).toBe(join(room.dir, 'e1'))
  })

  it('el segundo setMedia sube el epoch, para la sesión vieja y borra su directorio', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    const first = room.media!
    let stopped = false
    first.session.stop = async () => { stopped = true }
    // Marca en el directorio viejo: si sobreviviera, requestInit de la sesión
    // nueva podría servir un init de la película anterior.
    writeFileSync(join(first.dir, 'init_0.stable.mp4'), 'viejo')

    const second = await manager.setMedia(room.token, monoItems[0])

    expect(stopped).toBe(true)
    expect(second.epoch).toBe(2)
    expect(second.dir).toBe(join(room.dir, 'e2'))
    expect(existsSync(first.dir)).toBe(false)
    expect(second.setBy).toBeNull()
  })

  it('resetea la reproducción y el error al cambiar de película', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    room.state = { paused: false, positionBase: 500, updatedAt: 1, stalled: true }
    room.error = ['ffmpeg: boom']

    await manager.setMedia(room.token, monoItems[0])

    expect(room.state.paused).toBe(true)
    expect(room.state.positionBase).toBe(0)
    expect(room.state.stalled).toBe(false)
    expect(room.error).toBeNull()
  })

  it('notifica a los mediaListeners con el medio nuevo', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create()
    const seen: number[] = []
    room.mediaListeners.add(m => seen.push(m.epoch))

    await manager.setMedia(room.token, items[0])
    await manager.setMedia(room.token, monoItems[0])

    expect(seen).toEqual([1, 2])
  })

  // Un fichero que ffprobe no puede leer no debe dejar la sala a medias: la
  // película anterior tiene que seguir sonando y el directorio nuevo no debe
  // quedarse tirado en la caché.
  it('un fichero ilegible deja intacta la película anterior', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    const before = room.media!
    const brokenDir = mkdtempSync(join(tmpdir(), 'rmbroken-'))
    writeFileSync(join(brokenDir, 'roto.mkv'), 'esto no es un vídeo')
    const broken = (await scanLibrary([brokenDir]))[0]

    await expect(manager.setMedia(room.token, broken)).rejects.toThrow()

    expect(room.media).toBe(before)
    expect(room.media!.epoch).toBe(1)
    expect(existsSync(before.dir)).toBe(true)
    expect(existsSync(join(room.dir, 'e2'))).toBe(false)
  })

  it('rechaza un segundo cambio mientras hay uno en vuelo', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create()

    const first = manager.setMedia(room.token, items[0])
    await expect(manager.setMedia(room.token, monoItems[0])).rejects.toBeInstanceOf(RoomBusyError)
    await first

    expect(room.media!.epoch).toBe(1)
  })

  it('retry es no-op sin película y close funciona sin ella', async () => {
    let sessions = 0
    const manager = new RoomManager({ createSession: () => { sessions++; return fakeSession() } })
    const room = await manager.create()

    await manager.retry(room.token)
    expect(sessions).toBe(0)

    await manager.close(room.token)
    expect(manager.get(room.token)).toBeUndefined()
    expect(existsSync(room.dir)).toBe(false)
  })

  // create(item) es create() + setMedia(): si el probe falla, no debe quedar una
  // sala fantasma en el mapa con media a null.
  it('create(item) no deja sala si la preparación falla', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const brokenDir = mkdtempSync(join(tmpdir(), 'rmbroken2-'))
    writeFileSync(join(brokenDir, 'roto.mkv'), 'esto no es un vídeo')
    const broken = (await scanLibrary([brokenDir]))[0]

    await expect(manager.create(broken)).rejects.toThrow()

    expect(manager.all()).toHaveLength(0)
  })
})
```

Ajusta las importaciones de la cabecera del fichero de test:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { RoomManager, RoomBusyError } from '../src/rooms/roomManager.js'
import { scanLibrary } from '../src/library/scanner.js'
import { makeFixtureMkv } from './support/fixture.js'
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `npx vitest run test/roomManager.test.ts -w server`
Expected: FAIL. `create()` sin argumentos es error de tipos, `setMedia` no existe, `RoomBusyError` no se exporta.

- [ ] **Step 3: Implementar**

En `server/src/rooms/roomManager.ts`, cambia `media: RoomMedia` por `media: RoomMedia | null` en la interfaz `Room` y añade, antes de la clase:

```ts
/**
 * Un cambio de película (o un reintento) ya está en marcha en esta sala. El
 * host es una sola persona: se rechaza el segundo en vez de encadenar cerrojos.
 */
export class RoomBusyError extends Error {
  constructor() { super('La sala ya está cambiando de película') }
}

/** El medio ya construido, antes de que exista su sesión de ffmpeg. */
interface PreparedMedia {
  epoch: number; item: LibraryItem; info: MediaInfo; segments: Segment[]
  subtitles: SubtitleOption[]; meta: RoomMeta | null; dir: string
  mode: 'copy' | 'transcode'
}
```

Sustituye `create` y añade `prepareMedia` y `setMedia`:

```ts
  async create(item?: LibraryItem): Promise<Room> {
    const token = randomBytes(16).toString('base64url')
    const dir = join(cacheDir(), token)
    mkdirSync(dir, { recursive: true })
    const room: Room = {
      token, dir, media: null, state: initialState(Date.now()), chat: [], error: null, busy: false,
      errorListeners: new Set(), closeListeners: new Set(), mediaListeners: new Set(),
    }
    this.rooms.set(token, room)
    if (item) {
      // Una sala fantasma con media a null sería peor que ninguna: el host
      // creyó estar creando una sala CON película y el enlace no diría nada.
      try { await this.setMedia(token, item) } catch (e) { await this.close(token); throw e }
    }
    return room
  }

  /**
   * Todo el trabajo que puede fallar, antes de tocar la sala: si el fichero es
   * ilegible o ffprobe se atraganta, la película anterior sigue en marcha.
   */
  private async prepareMedia(item: LibraryItem, dir: string, epoch: number): Promise<PreparedMedia> {
    mkdirSync(dir, { recursive: true })
    const info = await probeFile(item.path)
    const mode = pickMode(info)
    // Solo copy corta donde diga la fuente; transcode fuerza su propia rejilla
    // de 4 s, así que ahí la lista de keyframes no solo sobra: planificar con
    // ella describiría cortes que ffmpeg no va a producir.
    const keyframes = mode === 'copy' ? await extractKeyframes(item.path) : null
    const segments = planSegments(info.durationSec, keyframes)
    const subtitles = listSubtitleOptions(info, item.srtFiles)
    for (const s of subtitles) {
      await extractSubtitle(item.path, info, item.srtFiles, s.id, join(dir, `sub_${s.id}.vtt`)).catch(() => {})
    }
    const meta = this.deps.lookupMeta ? await this.deps.lookupMeta(item.title) : null
    // Pistas de audio sin idioma declarado: se infiere del nombre del archivo o
    // del idioma original (TMDB) cuando solo hay una pista.
    info.audio = enrichAudioLangs(info.audio, basename(item.path), meta?.originalLang ?? null)
    return { epoch, item, info, segments, subtitles, meta, dir, mode }
  }

  async setMedia(token: string, item: LibraryItem, by: string | null = null): Promise<RoomMedia> {
    const room = this.rooms.get(token)
    if (!room) throw new Error(`Sala desconocida: ${token}`)
    if (room.busy) throw new RoomBusyError()
    room.busy = true

    const epoch = (room.media?.epoch ?? 0) + 1
    // Un subdirectorio por epoch, en vez de reutilizar el mismo: un cliente
    // puede estar descargando seg_0_00042.m4s de la película anterior justo
    // mientras el ffmpeg nuevo escribe un fichero con ese mismo nombre.
    const dir = join(room.dir, `e${epoch}`)
    let prepared: PreparedMedia
    try {
      prepared = await this.prepareMedia(item, dir, epoch)
    } catch (e) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* no llegó a existir */ }
      room.busy = false
      throw e
    }

    try {
      const previous = room.media
      // La sesión vieja se para ANTES de arrancar la nueva: así no hay dos
      // ffmpeg compitiendo por la CPU en el momento del cambio.
      await previous?.session.stop()
      const session = this.deps.createSession(prepared.item, prepared.info, prepared.segments, prepared.dir, prepared.mode)
      session.onError(log => { room.error = log; for (const cb of room.errorListeners) cb(log) })
      session.start()
      const media: RoomMedia = {
        epoch: prepared.epoch, item: prepared.item, info: prepared.info, segments: prepared.segments,
        subtitles: prepared.subtitles, meta: prepared.meta, session, dir: prepared.dir,
        setBy: by === null ? null : by.slice(0, 30),
      }
      room.media = media
      room.state = initialState(Date.now())
      room.error = null
      if (previous) {
        // Best-effort: en Windows un fichero con un descriptor abierto hace
        // fallar el borrado. Se queda huérfano y se lo lleva close().
        try { rmSync(previous.dir, { recursive: true, force: true }) } catch { /* se irá al cerrar */ }
      }
      for (const cb of room.mediaListeners) cb(media)
      return media
    } finally {
      room.busy = false
    }
  }
```

Añade las guardas a `retry` y `close`:

```ts
  async retry(token: string): Promise<void> {
    const room = this.rooms.get(token)
    if (!room) return
    if (room.busy) throw new RoomBusyError()
    const media = room.media
    // Sin película no hay nada que reintentar. El endpoint ya lo rechaza con
    // 409 antes de llegar aquí; esto es la segunda barrera.
    if (!media) return
    await media.session.stop()
    // …el resto del cuerpo se queda como está…
  }

  async close(token: string): Promise<void> {
    const room = this.rooms.get(token)
    if (!room) return
    await room.media?.session.stop()
    for (const cb of room.closeListeners) cb()
    rmSync(room.dir, { recursive: true, force: true })
    this.rooms.delete(token)
  }
```

Y añade el tipo `MediaInfo` a las importaciones si no está ya (lo usa `PreparedMedia`): la línea 7 ya importa `type MediaInfo`.

- [ ] **Step 4: Poner las guardas de nulo en los consumidores**

En `server/src/index.ts`, línea 30:

```ts
  const files = rooms.all().flatMap(r => r.media ? segmentFilesWithStats(r.media.dir) : [])
```

En `server/src/http/api.ts`, tres sitios, de momento solo para que compile (la Tarea 4 les da su forma final):

```ts
  // /api/status
  rooms: deps.rooms.all().map(r => ({ token: r.token, title: r.media?.item.title ?? 'Sin película' })),
```
```ts
  // GET /api/rooms/:token — la forma final llega en la Tarea 4
  const media = room.media
  if (!media) return { media: null, error: null, streamBase: deps.config.streamBaseUrl ?? '' }
```
```ts
  // GET /stream/:token/:file
  const media = room.media
  if (!media) return reply.code(404).send()
```

En `server/src/ws/hub.ts`, en el `switch`:

```ts
          case 'play': case 'pause': {
            // Sin película no hay reloj que mover: ni estado ni mensaje de
            // sistema. La sala vacía sirve para charlar mientras el host elige.
            if (!room.media) break
            room.state = apply(room.state, { type: msg.t, at: now })
            // …resto igual…
          }
          case 'seek': {
            if (!room.media) break
            if (typeof msg.position !== 'number' || !Number.isFinite(msg.position)) return
            const position = Math.min(Math.max(msg.position, 0), room.media.info.durationSec)
            room.state = apply(room.state, { type: 'seek', position, at: now })
            room.media.session.seekTo(segmentForTime(room.media.segments, position))
            // …resto igual…
          }
```

- [ ] **Step 5: Ejecutar los tests para verificar que pasan**

Run: `cd server && npx tsc --noEmit && cd .. && npx vitest run test/roomManager.test.ts -w server`
Expected: tsc sin salida, 15 tests en verde (los 6 que ya había más los 9 nuevos).

- [ ] **Step 6: Suite completa y commit**

Run: `npm run test -w server`
Expected: toda la suite en verde.

```bash
git add server/src/rooms/roomManager.ts server/src/http/api.ts server/src/ws/hub.ts server/src/index.ts server/test/roomManager.test.ts
git commit -m "feat: salas sin película y cambio de película con setMedia"
```

---

### Task 4: API — endpoint de medio y rutas de `/stream` versionadas

**Files:**
- Modify: `server/src/http/api.ts`
- Test: `server/test/api.test.ts`

**Interfaces:**
- Consumes: `RoomManager.create(item?)`, `setMedia(token, item, by?)`, `RoomBusyError`, `Room.media` (Tarea 3).
- Produces:
  - `POST /api/rooms` con `{ itemId?: string }` → `{ token }`
  - `POST /api/rooms/:token/media` (admin) con `{ itemId: string, by?: string }` → `{ epoch }`
  - `GET /api/rooms/:token` → `{ media: RoomMediaInfo | null, error: string[] | null, streamBase: string }` donde `RoomMediaInfo = { epoch, title, durationSec, audio, subtitles, meta }`
  - `GET|OPTIONS /stream/:token/:epoch/:file` con `:epoch` de forma `e<N>`

- [ ] **Step 1: Escribir los tests que fallan**

Las URLs de `/stream` cambian de forma, así que **todas** las llamadas a `/stream/${token}/…` de `api.test.ts` pasan a `/stream/${token}/e1/…`. Hazlo con una sustitución y luego añade los casos nuevos.

Cambia primero el test `creates a room and exposes public room info` a la forma nueva:

```ts
  it('creates a room and exposes public room info', async () => {
    const items = (await app.inject({ url: '/api/library', ...admin })).json()
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: { itemId: items[0].id }, ...admin })
    expect(res.statusCode).toBe(200)
    token = res.json().token
    expect(token.length).toBeGreaterThan(15)
    const info = (await app.inject({ url: `/api/rooms/${token}` })).json()
    expect(info.media.epoch).toBe(1)
    expect(info.media.audio).toHaveLength(2)
    expect(info.media.subtitles.length).toBeGreaterThanOrEqual(1)
    expect(info.error).toBeNull()
    // Sin streamBaseUrl configurado el cliente debe quedarse en el mismo origen.
    expect(info.streamBase).toBe('')
  })
```

Y el del relevo, que ahora lee `streamBase` en el mismo sitio (no cambia el cuerpo, solo confirma que sigue al nivel superior):

```ts
    expect(info.streamBase).toBe('https://stream.example.com')
```

Añade estos casos nuevos al final del `describe('api', …)`:

```ts
  it('crea una sala vacía cuando no se manda itemId', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: {}, ...admin })
    expect(res.statusCode).toBe(200)
    const empty = res.json().token

    const info = (await app.inject({ url: `/api/rooms/${empty}` })).json()
    expect(info.media).toBeNull()
    expect(info.error).toBeNull()
    expect(info.streamBase).toBe('')

    // Sin película, el plano de datos no existe en ninguna de sus formas.
    for (const file of ['master.m3u8', 'video.m3u8', 'audio_1.m3u8', 'init_0.mp4', 'seg_0_00000.m4s', 'sub_0.vtt']) {
      expect((await app.inject({ url: `/stream/${empty}/e1/${file}` })).statusCode).toBe(404)
    }
    await rooms.close(empty)
  })

  it('la sala vacía aparece en /api/status sin título de película', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: {}, ...admin })
    const empty = res.json().token
    const status = (await app.inject({ url: '/api/status', ...admin })).json()
    expect(status.rooms.find((r: any) => r.token === empty).title).toBe('Sin película')
    await rooms.close(empty)
  })

  it('cambiar de película exige admin', async () => {
    const items = (await app.inject({ url: '/api/library', ...admin })).json()
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${token}/media`, payload: { itemId: items[0].id } })
    expect(res.statusCode).toBe(401)
  })

  it('cambiar de película rechaza un item inexistente y una sala inexistente', async () => {
    expect((await app.inject({
      method: 'POST', url: `/api/rooms/${token}/media`, payload: { itemId: 'no-existe' }, ...admin,
    })).statusCode).toBe(404)
    expect((await app.inject({
      method: 'POST', url: '/api/rooms/NOEXISTE/media', payload: { itemId: 'x' }, ...admin,
    })).statusCode).toBe(404)
  })

  // Sin esta validación el endpoint sería un lector arbitrario de ficheros para
  // quien tenga la cookie: no se hereda de POST /api/rooms, hay que repetirla.
  it('cambiar de película rechaza un item fuera de las carpetas de medios', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'apifuera-'))
    await makeFixtureMkv(outsideDir)
    const outside = (await scanLibrary([outsideDir]))[0]
    const wideApp = await buildApp({
      config: { mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 },
      // La biblioteca declara el ítem, pero mediaFolders NO lo contiene.
      library: async () => [...await scanLibrary([mediaDir]), outside],
      rooms, adminToken: ADMIN, tunnel: { url: null },
    })

    const res = await wideApp.inject({
      method: 'POST', url: `/api/rooms/${token}/media`, payload: { itemId: outside.id }, ...admin,
    })
    expect(res.statusCode).toBe(400)

    await wideApp.close()
  })

  it('el epoch de una generación anterior da 410 (con CORS) y una forma inválida da 404', async () => {
    const items = (await app.inject({ url: '/api/library', ...admin })).json()
    const changed = await app.inject({
      method: 'POST', url: `/api/rooms/${token}/media`, payload: { itemId: items[0].id, by: 'Jaime' }, ...admin,
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json().epoch).toBe(2)

    const stale = await app.inject({ url: `/stream/${token}/e1/master.m3u8` })
    expect(stale.statusCode).toBe(410)
    // Un 410 cross-origin sin cabeceras CORS es un fallo mudo en el navegador.
    expect(stale.headers['access-control-allow-origin']).toBe('*')

    expect((await app.inject({ url: `/stream/${token}/e2/master.m3u8` })).statusCode).toBe(200)
    for (const bad of ['1', 'x2', 'e', 'ee2']) {
      expect((await app.inject({ url: `/stream/${token}/${bad}/master.m3u8` })).statusCode).toBe(404)
    }

    const info = (await app.inject({ url: `/api/rooms/${token}` })).json()
    expect(info.media.epoch).toBe(2)
  })

  it('el preflight de CORS cubre la ruta versionada', async () => {
    const pre = await app.inject({ method: 'OPTIONS', url: `/stream/${token}/e2/seg_0_00000.m4s` })
    expect(pre.statusCode).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBe('*')
    expect(pre.headers['access-control-allow-methods']).toContain('GET')
  })

  it('retry devuelve 409 en una sala sin película', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: {}, ...admin })
    const empty = res.json().token
    const retry = await app.inject({ method: 'POST', url: `/api/rooms/${empty}/retry` })
    expect(retry.statusCode).toBe(409)
    await rooms.close(empty)
  })
```

**Nota para el implementador:** el test de rate-limit de `/retry` (línea 204) usa `vi.spyOn(Date, 'now')`. `setMedia` llama a `Date.now()` para `initialState`; el test nuevo del epoch 410 va **después** en el fichero y no espía nada, así que no interfiere. Si al reordenar tests el spy quedara activo, `nowSpy.mockRestore()` en el `finally` correspondiente lo resuelve.

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `npx vitest run test/api.test.ts -w server`
Expected: FAIL. `POST /:token/media` da 404 (ruta inexistente), las URLs con `e1/` dan 404, `info.media` es `undefined`.

- [ ] **Step 3: Implementar**

En `server/src/http/api.ts`, añade la importación de `RoomBusyError`:

```ts
import { RoomBusyError } from '../rooms/roomManager.js'
```

Añade junto a las constantes de cabecera:

```ts
// El epoch va en el path y no en una query porque el plano de datos puede salir
// por un relevo ajeno (ver streamBaseUrl en config.ts): así el versionado no
// depende de que ese proxy reenvíe la query ni de cómo calcule su clave de
// caché. Y de paso planner.ts no necesita saber que el epoch existe: sus URIs
// son relativas y el navegador las resuelve dentro de e<n>/.
const EPOCH_RE = /^e(\d+)$/
```

Sustituye el bloque de rooms (líneas 61-94) por:

```ts
  // Resuelve el ítem y valida que esté dentro de las carpetas de medios. Envía
  // la respuesta de error y devuelve null; el llamador hace `return reply`.
  const resolveItem = async (itemId: string | undefined, reply: FastifyReply) => {
    const item = (await deps.library()).find(i => i.id === itemId)
    if (!item) { reply.code(404).send({ error: 'item not found' }); return null }
    if (!deps.config.mediaFolders.some(f => isPathInside(f, item.path))) {
      reply.code(400).send({ error: 'path outside media folders' })
      return null
    }
    return item
  }

  app.post('/api/rooms', { preHandler: requireAdmin }, async (req, reply) => {
    const { itemId } = (req.body ?? {}) as { itemId?: string }
    // Sin itemId, sala vacía: el host reparte el enlace y elige luego, con la
    // gente ya dentro charlando.
    if (itemId === undefined) return { token: (await deps.rooms.create()).token }
    const item = await resolveItem(itemId, reply)
    if (!item) return reply
    return { token: (await deps.rooms.create(item)).token }
  })

  app.post('/api/rooms/:token/media', { preHandler: requireAdmin }, async (req, reply) => {
    const { token } = req.params as { token: string }
    const room = deps.rooms.get(token)
    if (!room) return reply.code(404).send({ error: 'room not found' })
    const { itemId, by } = (req.body ?? {}) as { itemId?: string; by?: string }
    const item = await resolveItem(itemId, reply)
    if (!item) return reply
    try {
      const media = await deps.rooms.setMedia(token, item, typeof by === 'string' ? by : null)
      // El enfriamiento de reintento de la película anterior no debe aplicarse
      // a la nueva: son ejecuciones de ffmpeg distintas.
      lastRetryAt.delete(token)
      return { epoch: media.epoch }
    } catch (e) {
      if (e instanceof RoomBusyError) return reply.code(409).send({ error: 'room busy' })
      throw e
    }
  })

  app.delete('/api/rooms/:token', { preHandler: requireAdmin }, async (req) => {
    await deps.rooms.close((req.params as any).token)
    return { ok: true }
  })

  app.get('/api/rooms/:token', async (req, reply) => {
    const room = deps.rooms.get((req.params as any).token)
    if (!room) return reply.code(404).send({ error: 'room not found' })
    const media = room.media
    // '' = mismo origen (ver streamBaseUrl en config.ts). Va al nivel superior y
    // no dentro de `media` porque describe dónde vive el servidor, no la
    // película: el cliente lo necesita igual en una sala vacía. Y viaja en esta
    // respuesta, que el cliente ya espera antes de montar el reproductor, para
    // no abrir una ventana en la que el <video> exista sin saber su origen.
    const streamBase = deps.config.streamBaseUrl ?? ''
    if (!media) return { media: null, error: null, streamBase }
    return {
      media: {
        epoch: media.epoch,
        title: displayTitle(media.meta, media.item.title),
        durationSec: media.info.durationSec,
        audio: media.info.audio,
        subtitles: media.subtitles,
        meta: media.meta,
      },
      error: room.error,
      streamBase,
    }
  })

  app.post('/api/rooms/:token/retry', async (req, reply) => {
    const room = deps.rooms.get((req.params as any).token)
    if (!room) return reply.code(404).send()
    // Sin película no hay ejecución de ffmpeg que reintentar.
    if (!room.media) return reply.code(409).send({ error: 'room has no media' })
    const now = Date.now()
    const last = lastRetryAt.get(room.token)
    if (last !== undefined && now - last < RETRY_COOLDOWN_MS) return reply.code(429).send({ error: 'retry cooldown' })
    lastRetryAt.set(room.token, now)
    try {
      await deps.rooms.retry(room.token)
    } catch (e) {
      if (e instanceof RoomBusyError) return reply.code(409).send({ error: 'room busy' })
      throw e
    }
    return { ok: true }
  })
```

Sustituye la ruta `OPTIONS` y la cabecera del handler `GET` de `/stream` por la forma versionada (el resto del cuerpo del `GET`, desde `if (file === 'master.m3u8')`, se queda igual, ya usando `media`):

```ts
  app.options('/stream/:token/:epoch/:file', async (_req, reply) => allowCors(reply)
    .header('access-control-allow-methods', 'GET, HEAD, OPTIONS')
    .header('access-control-allow-headers', 'range')
    .header('access-control-max-age', '86400')
    .code(204).send())

  app.get('/stream/:token/:epoch/:file', async (req, reply) => {
    const { token, epoch, file } = req.params as { token: string; epoch: string; file: string }
    // Antes que nada, incluido el 404: un error cross-origin sin cabeceras CORS
    // se lo traga el navegador sin dejar rastro que mirar.
    allowCors(reply)
    const room = deps.rooms.get(token)
    if (!room) return reply.code(404).send()
    const media = room.media
    if (!media) return reply.code(404).send()
    const parsed = epoch.match(EPOCH_RE)
    // Forma inválida: nunca fue una URL nuestra.
    if (!parsed) return reply.code(404).send()
    // Generación anterior: existió y ya no. 410 y no 404 porque durante la
    // transición la instancia vieja de hls.js sigue pidiendo estas URLs, y sin
    // este corte requestInit las dejaría colgadas 30 s esperando un fichero de
    // un directorio ya borrado.
    if (Number(parsed[1]) !== media.epoch) return reply.code(410).send()

    if (file === 'master.m3u8') return reply.type(M3U8).send(buildMasterPlaylist(media.info.audio))
    // …el resto del handler, sin cambios…
  })
```

- [ ] **Step 4: Ejecutar los tests para verificar que pasan**

Run: `cd server && npx tsc --noEmit && cd .. && npx vitest run test/api.test.ts -w server`
Expected: tsc sin salida, toda la suite de `api.test.ts` en verde.

- [ ] **Step 5: Suite completa y commit**

Run: `npm run test -w server`
Expected: verde. `hub.test.ts` no toca `/stream`, así que no debería verse afectado.

```bash
git add server/src/http/api.ts server/test/api.test.ts
git commit -m "feat: endpoint de cambio de película y rutas de stream por epoch"
```

---

### Task 5: WebSocket — difundir el cambio y no romper la sala vacía

**Files:**
- Modify: `server/src/ws/messages.ts:15-23`
- Modify: `server/src/ws/hub.ts:52-68`
- Test: `server/test/hub.test.ts`

**Interfaces:**
- Consumes: `Room.mediaListeners`, `RoomMedia` (Tarea 3); `RoomManager.setMedia` (Tarea 3).
- Produces: `ServerMsg` gana `{ t: 'media'; epoch: number }`.

- [ ] **Step 1: Escribir los tests que fallan**

Añade al final del `describe('hub', …)` de `server/test/hub.test.ts`:

```ts
  it('una sala sin película deja chatear pero ignora play y seek', async () => {
    const room = await rooms.create()
    const a = await connect('Kira', room.token)
    const w = await a.recv()
    expect(w.t).toBe('welcome')
    await a.recv(); await a.recv() // presence propio + system "se unió"

    // Ni estado ni mensaje de sistema: no hay reloj que mover.
    a.ws.send(JSON.stringify({ t: 'play' }))
    a.ws.send(JSON.stringify({ t: 'seek', position: 10 }))
    // El chat sí funciona, y es lo único que debe llegar.
    a.ws.send(JSON.stringify({ t: 'chat', text: 'esperando' }))
    const next = await a.recv()
    expect(next.t).toBe('chat')
    expect(next.entry.text).toBe('esperando')
    expect(room.state.paused).toBe(true)
    expect(room.state.positionBase).toBe(0)

    a.ws.close()
  })

  it('poner película difunde media + state y lo cuenta en el chat', async () => {
    const room = await rooms.create()
    const a = await connect('Lena', room.token)
    await a.recv(); await a.recv(); await a.recv() // welcome, presence, system

    await rooms.setMedia(room.token, items[0], 'Jaime')

    const msgs = [await a.recv(), await a.recv(), await a.recv()]
    const media = msgs.find(m => m.t === 'media')!
    expect(media.epoch).toBe(1)
    const state = msgs.find(m => m.t === 'state')!
    expect(state.state.paused).toBe(true)
    expect(state.state.positionBase).toBe(0)
    const sys = msgs.find(m => m.t === 'chat')!
    expect(sys.entry.kind).toBe('system')
    expect(sys.entry.text).toContain('Jaime')

    a.ws.close()
  })

  it('sin `by` el mensaje de sistema es impersonal', async () => {
    const room = await rooms.create()
    const a = await connect('Ona', room.token)
    await a.recv(); await a.recv(); await a.recv()

    await rooms.setMedia(room.token, items[0])

    const msgs = [await a.recv(), await a.recv(), await a.recv()]
    const sys = msgs.find(m => m.t === 'chat')!
    expect(sys.entry.text).toContain('ahora se ve')

    a.ws.close()
  })

  // Un socket marcado como «cargando» en la película anterior no vuelve a emitir
  // el flanco: si su marca sobrevive al cambio, la sala nueva se congela en el
  // primer play y nadie la saca de ahí hasta agotar el tope.
  it('el cambio de película limpia el set de buffering', async () => {
    const room = await rooms.create(items[0])
    const a = await connect('Bruno', room.token)
    await a.recv(); await a.recv(); await a.recv()

    a.ws.send(JSON.stringify({ t: 'buffering', value: true }))
    const frozen = [await a.recv(), await a.recv()]
    expect(frozen.find(m => m.t === 'state')!.state.stalled).toBe(true)

    await rooms.setMedia(room.token, monoItems[0], 'Jaime')
    await a.recv(); await a.recv(); await a.recv() // media, state, system

    a.ws.send(JSON.stringify({ t: 'play' }))
    const afterPlay = [await a.recv(), await a.recv()]
    const state = afterPlay.find(m => m.t === 'state')!
    expect(state.state.paused).toBe(false)
    expect(state.state.stalled).toBe(false)

    a.ws.close()
  })
```

El fichero necesita un segundo ítem para poder cambiar de película. Añade en el `beforeAll`, después de `items = await scanLibrary([mediaDir])`:

```ts
  const monoDir = mkdtempSync(join(tmpdir(), 'hubmono-'))
  await makeFixtureMkv(monoDir, { audioTracks: 1 })
  monoItems = await scanLibrary([monoDir])
```

Y la declaración junto a las otras de la cabecera:

```ts
let monoItems: Awaited<ReturnType<typeof scanLibrary>>
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `npx vitest run test/hub.test.ts -w server`
Expected: FAIL. Los tests que esperan `{t:'media'}` se quedan colgados hasta el timeout de Vitest porque nadie lo difunde.

- [ ] **Step 3: Implementar**

En `server/src/ws/messages.ts`, añade la variante al final de `ServerMsg`:

```ts
  | { t: 'error'; log: string[] }
  // El cliente refetchea GET /api/rooms/:token y remonta el reproductor con
  // `epoch` como key. No se manda la info aquí para no duplicar la forma de esa
  // respuesta en dos sitios que puedan divergir.
  | { t: 'media'; epoch: number }
```

En `server/src/ws/hub.ts`, añade la importación de `displayTitle` y del tipo `RoomMedia`:

```ts
import type { Room, RoomMedia } from '../rooms/roomManager.js'
import { displayTitle } from '../media/tmdb.js'
```

Añade esta función junto a `closeRoomSockets`:

```ts
// Un cambio de película: el reloj vuelve a cero, el reproductor de cada cliente
// se reconstruye y el chat se queda como estaba.
function onMediaChanged(room: Room, media: RoomMedia): void {
  const now = Date.now()
  // Re-attach y no solo un refresh: `attach` hace `detach` primero, así que el
  // set de buffering nace vacío. Un socket que quedó marcado como «cargando» en
  // la película anterior no va a emitir otro flanco, y su marca congelaría la
  // nueva desde el primer play sin que nadie pueda sacarla de ahí.
  stall.attach(room, () => broadcast(room, { t: 'state', state: room.state, serverNow: Date.now() }))
  broadcast(room, { t: 'media', epoch: media.epoch })
  broadcast(room, { t: 'state', state: room.state, serverNow: now })
  const title = displayTitle(media.meta, media.item.title)
  system(room, media.setBy ? `${media.setBy} puso «${title}»` : `ahora se ve «${title}»`)
}
```

Y regístrala en el bloque de enganches por sala (líneas 56-64):

```ts
    if (!conns.has(room)) {
      conns.set(room, new Map())
      // One-time-per-room hookups: fan out ffmpeg errors from RoomManager to
      // every client currently (and later) connected to this room, close every
      // socket once the room itself is torn down, y avisar del cambio de
      // película.
      room.errorListeners.add(log => broadcast(room, { t: 'error', log }))
      room.closeListeners.add(() => closeRoomSockets(room))
      room.mediaListeners.add(media => onMediaChanged(room, media))
      stall.attach(room, () => broadcast(room, { t: 'state', state: room.state, serverNow: Date.now() }))
    }
```

- [ ] **Step 4: Ejecutar los tests para verificar que pasan**

Run: `cd server && npx tsc --noEmit && cd .. && npx vitest run test/hub.test.ts -w server`
Expected: tsc sin salida, toda la suite de `hub.test.ts` en verde.

- [ ] **Step 5: Suite completa de server y commit**

Run: `npm run test -w server`
Expected: verde.

```bash
git add server/src/ws/messages.ts server/src/ws/hub.ts server/test/hub.test.ts
git commit -m "feat: el hub difunde el cambio de película y la sala vacía deja chatear"
```

---

### Task 6: Cliente — tipos, URLs con epoch y `Player`

**Files:**
- Modify: `web/src/types.ts:56-63`
- Modify: `web/src/api.ts:17-19,48`
- Modify: `web/src/player/streamUrl.ts`
- Modify: `web/src/player/Player.tsx`
- Test: `web/test/streamUrl.test.ts`

**Interfaces:**
- Consumes: la forma de `GET /api/rooms/:token` y las rutas `/stream/:token/e<n>/:file` (Tarea 4); `{t:'media', epoch}` (Tarea 5).
- Produces:
  ```ts
  // web/src/types.ts
  export interface RoomMediaInfo { epoch: number; title: string; durationSec: number
    audio: AudioTrack[]; subtitles: SubtitleOption[]; meta: RoomMeta | null }
  export interface RoomInfo { media: RoomMediaInfo | null; error: string[] | null; streamBase: string }
  // web/src/player/streamUrl.ts
  export function streamUrl(base: string | null | undefined, token: string, epoch: number, file: string): string
  // web/src/api.ts
  export const createRoom: (itemId?: string) => Promise<{ token: string }>
  export const setRoomMedia: (token: string, itemId: string, by?: string) => Promise<{ epoch: number }>
  export const rescanLibrary: () => Promise<LibraryItem[]>
  // web/src/player/Player.tsx
  export function Player(props: { token: string; media: RoomMediaInfo; streamBase: string
    send: (m: ClientMsg) => void; lastState: LastState | null; welcomeCount: number
    fullscreen: boolean; onToggleFullscreen: () => void }): JSX.Element
  ```

- [ ] **Step 1: Escribir el test que falla**

En `web/test/streamUrl.test.ts`, la firma gana un parámetro. Actualiza las llamadas existentes intercalando el epoch y añade dos casos nuevos:

```ts
import { describe, it, expect } from 'vitest'
import { streamUrl } from '../src/player/streamUrl'

describe('streamUrl', () => {
  it('sin base usa el mismo origen (comportamiento en LAN y sin relevo)', () => {
    expect(streamUrl('', 'tok', 1, 'master.m3u8')).toBe('/stream/tok/e1/master.m3u8')
  })

  // El servidor manda '' cuando no hay relevo, pero el tipo permite null/undefined
  // (config sin el campo, respuesta de una versión vieja): ninguno debe acabar
  // como el literal 'null' dentro de la URL.
  it('trata null y undefined como mismo origen', () => {
    expect(streamUrl(null, 'tok', 1, 'video.m3u8')).toBe('/stream/tok/e1/video.m3u8')
    expect(streamUrl(undefined, 'tok', 1, 'video.m3u8')).toBe('/stream/tok/e1/video.m3u8')
  })

  it('antepone el origen del relevo', () => {
    expect(streamUrl('https://stream.example.com', 'tok', 3, 'master.m3u8'))
      .toBe('https://stream.example.com/stream/tok/e3/master.m3u8')
  })

  it('no duplica la barra cuando la base ya la trae', () => {
    expect(streamUrl('https://stream.example.com/', 'tok', 1, 'init_0.mp4'))
      .toBe('https://stream.example.com/stream/tok/e1/init_0.mp4')
    expect(streamUrl('https://stream.example.com///', 'tok', 1, 'init_0.mp4'))
      .toBe('https://stream.example.com/stream/tok/e1/init_0.mp4')
  })

  it('conserva el prefijo de ruta de una base con subdirectorio', () => {
    expect(streamUrl('https://example.com/relay', 'tok', 2, 'sub_0.vtt'))
      .toBe('https://example.com/relay/stream/tok/e2/sub_0.vtt')
  })

  // Lo que hace que el resto de la playlist siga al mismo host sin tocar el
  // servidor: los nombres relativos que emite planner.ts se resuelven contra la
  // URL del master, así que basta con que ESTA apunte al relevo.
  it('el master queda en un directorio del que cuelgan los nombres relativos', () => {
    const master = streamUrl('https://stream.example.com', 'tok', 1, 'master.m3u8')
    expect(new URL('seg_0_00001.m4s', master).href)
      .toBe('https://stream.example.com/stream/tok/e1/seg_0_00001.m4s')
  })

  // La razón de meter el epoch en el PATH y no en una query: los nombres
  // relativos de la playlist caen dentro de e<n>/ solos, así que planner.ts
  // puede seguir sin saber que el epoch existe.
  it('los nombres relativos caen dentro del epoch del master', () => {
    const master = streamUrl('', 'tok', 7, 'master.m3u8')
    expect(new URL('video.m3u8', `https://app.example.com${master}`).pathname)
      .toBe('/stream/tok/e7/video.m3u8')
    expect(new URL('init_0.mp4', `https://app.example.com${master}`).pathname)
      .toBe('/stream/tok/e7/init_0.mp4')
  })

  // Dos generaciones de la misma sala NO comparten URL: es lo que impide que la
  // caché del navegador (o la del relevo) sirva los bytes de la película
  // anterior, porque init_0.mp4 y seg_0_00000.m4s se llaman igual en las dos.
  it('dos epochs de la misma sala no comparten URL', () => {
    expect(streamUrl('', 'tok', 1, 'seg_0_00000.m4s'))
      .not.toBe(streamUrl('', 'tok', 2, 'seg_0_00000.m4s'))
  })
})
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

Run: `npx vitest run test/streamUrl.test.ts -w web`
Expected: FAIL. La firma vieja pone el epoch donde va el fichero: sale `/stream/tok/1`.

- [ ] **Step 3: Implementar `streamUrl`**

Reemplaza `web/src/player/streamUrl.ts` entero:

```ts
// El plano de datos (playlists, init, segmentos, VTT) puede vivir en un origen
// distinto al de la app: ver `streamBaseUrl` en server/src/config.ts para el por
// qué. Aquí solo se compone la URL.
//
// El `epoch` versiona la generación de película de la sala. Va en el PATH y no
// en una query por dos razones: los nombres relativos de una playlist se
// resuelven contra la URL de esa playlist, así que init_*.mp4 y seg_*.m4s caen
// dentro de e<n>/ solos y planner.ts no necesita saber que el epoch existe; y
// así el versionado no depende de que el proxy del relevo reenvíe la query ni
// de cómo calcule su clave de caché.
//
// Basta con aplicarlo a master.m3u8 y a los VTT: el resto de la playlist sigue
// al host y al epoch del master. Los <track>, en cambio, los construye la app y
// no la playlist, así que esos sí pasan por aquí.
export function streamUrl(base: string | null | undefined, token: string, epoch: number, file: string): string {
  // Se recorta la barra final para no emitir `https://host//stream/...`: un
  // doble slash sobrevive a la normalización de la URL y rompe el prefijo contra
  // el que se resuelven los nombres relativos de la playlist.
  const root = (base ?? '').replace(/\/+$/, '')
  return `${root}/stream/${token}/e${epoch}/${file}`
}
```

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

Run: `npx vitest run test/streamUrl.test.ts -w web`
Expected: PASS, 8 tests.

- [ ] **Step 5: Actualizar los tipos**

En `web/src/types.ts`, sustituye la interfaz `RoomInfo` (líneas 56-63) por:

```ts
export interface RoomMediaInfo {
  /** Generación de película de la sala: versiona las URLs y remonta el player. */
  epoch: number
  title: string
  durationSec: number
  audio: AudioTrack[]
  subtitles: SubtitleOption[]
  meta: RoomMeta | null
}

export interface RoomInfo {
  /** null = el host todavía no ha elegido película. */
  media: RoomMediaInfo | null
  error: string[] | null
  // Origen del que pedir el vídeo; '' = mismo origen que la app. Al nivel
  // superior y no dentro de `media`: describe dónde vive el servidor, no la
  // película, y hace falta igual en una sala vacía.
  streamBase: string
}
```

Y añade la variante al final de `ServerMsg`:

```ts
  | { t: 'error'; log: string[] }
  | { t: 'media'; epoch: number }
```

- [ ] **Step 6: Actualizar `api.ts`**

En `web/src/api.ts`, sustituye `createRoom` (líneas 18-19) y añade dos funciones:

```ts
// Sin itemId el servidor crea una sala vacía: el host reparte el enlace y elige
// película después, con la gente ya dentro.
export const createRoom = (itemId?: string) =>
  fetch('/api/rooms', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(itemId === undefined ? {} : { itemId }),
  }).then(r => json<{ token: string }>(r))

export const rescanLibrary = () =>
  fetch('/api/library/rescan', { method: 'POST' }).then(r => json<LibraryItem[]>(r))

// `by` es el nombre del propio host, que su navegador conoce por el `welcome`:
// el servidor no puede saber que la cookie de admin es el participante «Jaime».
export const setRoomMedia = async (token: string, itemId: string, by?: string) => {
  const r = await fetch(`/api/rooms/${token}/media`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemId, by }),
  })
  if (!r.ok) {
    const body = await r.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${r.status}`)
  }
  return r.json() as Promise<{ epoch: number }>
}
```

- [ ] **Step 7: Adaptar `Player.tsx`**

La prop `info: RoomInfo` pasa a `media: RoomMediaInfo` más `streamBase: string`. Cambios, uno a uno:

1. Importación de tipos: `import type { ClientMsg, PlaybackState, RoomMediaInfo } from '../types'`.
2. Firma y desestructuración:
   ```ts
   export function Player({ token, media, streamBase, send, lastState, welcomeCount, fullscreen, onToggleFullscreen }: {
     token: string; media: RoomMediaInfo; streamBase: string
     send: (m: ClientMsg) => void; lastState: LastState | null
     welcomeCount: number
     fullscreen: boolean
     onToggleFullscreen: () => void
   }) {
   ```
3. `const infoRef = useRef(info)` / `infoRef.current = info` → `const mediaRef = useRef(media)` / `mediaRef.current = media`, y las dos lecturas dentro del tick de deriva: `infoRef.current.durationSec` → `mediaRef.current.durationSec` (dos veces, en el cálculo de `nearEnd`).
4. El efecto de hls.js:
   ```ts
       const master = streamUrl(streamBase, token, media.epoch, 'master.m3u8')
   ```
   y su lista de dependencias:
   ```ts
       // Primitivas y no el objeto: el de la sala llega nuevo de cada fetch y
       // remontaría hls.js sin motivo. El remonte por `key={epoch}` en Room.tsx
       // sí es intencionado, y `epoch` está aquí para que la lista no mienta.
     }, [token, streamBase, media.epoch])
   ```
5. Los `<track>` y el `crossOrigin`:
   ```ts
         <video ref={videoRef} playsInline crossOrigin={streamBase ? 'anonymous' : undefined}
           onClick={onVideoClick} onDoubleClick={onVideoDoubleClick}>
           {media.subtitles.map(s => (
             <track key={s.id} kind="subtitles" label={s.label} srcLang={s.lang}
               src={streamUrl(streamBase, token, media.epoch, `sub_${s.id}.vtt`)} />
           ))}
         </video>
   ```
6. El resto de `info.` pasa a `media.`: `info.durationSec` en `roomPosition`, `remaining`, el `min`/`max` y el `disabled` de la barra de posición, los dos `aria-valuetext`/`title` del tiempo, el `clampPosition` de `commitSeek`, y `info.subtitles` en el `<select>` de subtítulos.

Comprueba que no queda ninguno: `rtk grep -n "info\." web/src/player/Player.tsx` no debe devolver nada.

- [ ] **Step 8: Verificar y commitear**

`Room.tsx` todavía pasa `info={info}` y no compilará: eso es lo que arregla la Tarea 7. Para poder commitear con la compilación verde, haz el cambio mínimo en `web/src/pages/Room.tsx` ahora — la pantalla de sala vacía llega en la Tarea 7:

```tsx
  if (!info.media) return <main className="page"><p className="loading">Encendiendo el proyector…</p></main>
```

justo antes del `if (errorLog)`, y en el JSX:

```tsx
          <Player key={info.media.epoch} token={token} media={info.media} streamBase={info.streamBase}
            send={m => sendRef.current(m)} lastState={lastState} welcomeCount={welcomeCount}
            fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />
```

Y los otros tres usos de `info` en ese fichero: `info?.title` → `info?.media?.title` (la puerta del nombre), `info.title` → `info.media.title` (la cabecera) y las dos guardas de `info.meta` → `info.media.meta`.

Run: `cd web && npx tsc --noEmit && cd .. && npm run test -w web && npm run build -w web`
Expected: tsc sin salida, 113 tests en verde, build correcto.

```bash
git add web/src/types.ts web/src/api.ts web/src/player/streamUrl.ts web/src/player/Player.tsx web/src/pages/Room.tsx web/test/streamUrl.test.ts
git commit -m "feat: el cliente versiona las URLs de stream por epoch"
```

---

### Task 7: `Room.tsx` — sala vacía, `isHost` y refresco suave

**Files:**
- Modify: `web/src/pages/Room.tsx`

**Interfaces:**
- Consumes: `RoomInfo` con `media | null` (Tarea 6), `{t:'media'}` (Tarea 5).
- Produces: nada que consuman otras tareas, salvo que la Tarea 8 monta `<MediaPicker>` desde aquí.

- [ ] **Step 1: Añadir el estado de host y el refetch del medio**

En `web/src/pages/Room.tsx`, junto a los demás `useState`:

```tsx
  // Solo el host: /api/status responde 401 a los invitados. Es la misma señal
  // que ya se usaba para el enlace del túnel, ahora con nombre propio, porque
  // gobierna también el botón de elegir película.
  const [isHost, setIsHost] = useState(false)
```

Extrae el fetch de la sala a una función reutilizable y úsala en el efecto de montaje (sustituye el `useEffect` de las líneas 123-129):

```tsx
  const reloadInfo = useCallback(async () => {
    try { setInfo(await getRoom(token)) } catch { setNotFound(true) }
  }, [token])

  useEffect(() => { void reloadInfo() }, [reloadInfo])
```

Añade `useCallback` a la importación de React.

En el efecto del socket, atiende el mensaje nuevo:

```tsx
      if (m.t === 'media') {
        // Un solo camino de refresco, también para el host que lo provocó: el
        // POST no actualiza estado por su cuenta, así que no hay dos rutas que
        // puedan divergir. El `wsError` se limpia porque el fallo de ffmpeg era
        // de la película anterior.
        setWsError(null)
        void reloadInfo()
      }
```

y añade `reloadInfo` a las dependencias de ese efecto: `}, [token, name, notFound, reloadInfo])`.

En el sondeo de `/api/status`, marca al host:

```tsx
        .then(s => {
          if (cancelled) return
          setIsHost(true)
          setTunnelUrl(s.tunnelUrl)
          setTunnelDown(s.tunnelUrl === null)
        })
        // 401: es un invitado. Se deja de sondear, no se le enseña el enlace del
        // túnel y no verá el botón de elegir película.
        .catch(() => { polling = false; setIsHost(false) })
```

- [ ] **Step 2: Sustituir el placeholder por la pantalla de sala vacía**

Quita el `if (!info.media) return …` provisional de la Tarea 6. La cabecera de la sala y la rejilla se comparten entre los dos estados, así que el cambio va **dentro** del JSX final: sustituye el bloque `<div className="video-stage">` por:

```tsx
        <div className="video-stage">
          {info.media ? (
            <>
              <Player key={info.media.epoch} token={token} media={info.media} streamBase={info.streamBase}
                send={m => sendRef.current(m)} lastState={lastState} welcomeCount={welcomeCount}
                fullscreen={fullscreen} onToggleFullscreen={toggleFullscreen} />
              <ReactionOverlay reactions={chat.reactions} onDrop={id => dispatchChat({ t: 'drop-reaction', id })} />
              <ReactionsBar send={m => sendRef.current(m)} />
            </>
          ) : (
            // El chat sigue montado a la derecha: la gente entra, pone su nombre
            // y charla mientras el host elige.
            <div className="stage-waiting">
              <p className="eyebrow">Sin película todavía</p>
              <h2>{isHost ? 'Elige qué vais a ver' : 'El host está eligiendo la película'}</h2>
              <p className="hint">{isHost
                ? 'Mientras tanto puedes copiar el enlace y repartirlo: la sala ya existe.'
                : 'Puedes ir charlando en el chat; el vídeo aparecerá solo.'}</p>
            </div>
          )}
        </div>
```

Y adapta la cabecera para que no asuma película:

```tsx
        <div className="room-head-titles">
          <h1>{info.media ? info.media.title : 'Sala sin película'}</h1>
        </div>
```

- [ ] **Step 3: Comprobar los estados dependientes de película**

Tres sitios más en el mismo fichero:

- La puerta del nombre ya usa `info?.media?.title ?? 'la función'` desde la Tarea 6: correcto también en sala vacía.
- El botón de Info y el modal: `{info.media?.meta && …}` y `{showMeta && info.media?.meta && <MetaModal meta={info.media.meta} … />}`.
- `errorLog`: `const errorLog = wsError ?? info?.error` se queda igual — el servidor manda `error: null` cuando no hay película, así que la pantalla de error no puede aparecer en una sala vacía.

- [ ] **Step 4: Verificar y commitear**

Run: `cd web && npx tsc --noEmit && cd .. && npm run test -w web && npm run build -w web`
Expected: tsc sin salida, tests en verde, build correcto.

```bash
git add web/src/pages/Room.tsx
git commit -m "feat: la sala sin película enseña el cartel de espera con el chat vivo"
```

---

### Task 8: `MediaPicker` — el modal de selección, pensado para biblioteca grande

**Files:**
- Create: `web/src/MediaPicker.tsx`
- Modify: `web/src/pages/Room.tsx`
- Modify: `web/src/theme.css`

**Interfaces:**
- Consumes: `getLibrary`, `rescanLibrary`, `setRoomMedia` (Tarea 6); `LibraryItem` con `folderPath` (Tarea 1).
- Produces:
  ```ts
  export function groupByFolder(items: LibraryItem[]): { path: string; name: string; items: LibraryItem[] }[]
  export function MediaPicker(props: {
    token: string
    // Título de la película en emisión, para marcarla; null en sala vacía. Se
    // compara por TÍTULO y no por ruta: `RoomInfo` no lleva la ruta absoluta del
    // fichero, y no debe — es una ruta del disco del host, no algo que tengan
    // que ver los invitados.
    currentTitle: string | null
    by: string                      // nombre del host, para el mensaje de sistema
    onClose: () => void
  }): JSX.Element
  ```

**Por qué así:** una biblioteca real es una carpeta recursiva con cientos de medios. Se sigue el patrón que ya usa `EmojiPicker` con sus 1.906 emojis: **nunca se pinta todo a la vez**. El modal reutiliza las clases `modal-backdrop` / `modal` / `modal-close` de `MetaModal`.

- [ ] **Step 1: Crear el componente**

Crea `web/src/MediaPicker.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'
import { getLibrary, rescanLibrary, setRoomMedia } from './api'
// Se reutilizan del buscador de emojis en vez de duplicarlos: `normalize` ya
// hace el NFD sin diacríticos que hace falta para que «corazon» encuentre
// «Corazón», y `SEARCH_LIMIT` ya es el tope de 120 resultados que evita meter
// cientos de botones en el DOM.
import { normalize, SEARCH_LIMIT } from './chat/emojiSearch'
import type { LibraryItem } from './types'

interface Folder { path: string; name: string; items: LibraryItem[] }

export function groupByFolder(items: LibraryItem[]): Folder[] {
  const byPath = new Map<string, Folder>()
  for (const i of items) {
    // Por folderPath y no por folderName: dos series pueden tener una «Season 1»
    // cada una, y agrupar por nombre las fusiona con los episodios mezclados.
    const f = byPath.get(i.folderPath) ?? { path: i.folderPath, name: i.folderName, items: [] }
    f.items.push(i)
    byPath.set(i.folderPath, f)
  }
  return [...byPath.values()]
}

export function MediaPicker({ token, currentTitle, by, onClose }: {
  token: string
  currentTitle: string | null
  by: string
  onClose: () => void
}) {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Confirmación en dos pasos DENTRO del modal, no `window.confirm`: un diálogo
  // nativo puede sacar al host de pantalla completa, y el proyecto ya resuelve
  // esto con modales propios en vez de nativos (ver EmojiPicker).
  const [pending, setPending] = useState<LibraryItem | null>(null)

  useEffect(() => {
    let cancelled = false
    getLibrary()
      .then(l => { if (!cancelled) setItems(l) })
      .catch(e => { if (!cancelled) { setItems([]); setError(e instanceof Error ? e.message : String(e)) } })
    return () => { cancelled = true }
  }, [])

  const folders = useMemo(() => groupByFolder(items ?? []), [items])

  // Arranca abierta la carpeta de la película puesta; si no hay, la primera.
  useEffect(() => {
    if (open !== null || folders.length === 0) return
    const current = currentTitle ? folders.find(f => f.items.some(i => i.title === currentTitle)) : null
    setOpen((current ?? folders[0]).path)
  }, [folders, currentTitle, open])

  const searching = query.trim() !== ''
  const results = useMemo(() => {
    if (!searching) return []
    const q = normalize(query.trim())
    return (items ?? []).filter(i => normalize(i.title).includes(q)).slice(0, SEARCH_LIMIT)
  }, [items, query, searching])

  const apply = async (item: LibraryItem) => {
    setBusy(true)
    setError(null)
    try {
      await setRoomMedia(token, item.id, by)
      // La sala se refresca sola con el {t:'media'} que llega por el socket.
      onClose()
    } catch (e) {
      // Se muestra dentro del modal sin cerrarlo, para poder elegir otra cosa.
      setError(e instanceof Error ? e.message : String(e))
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  // Cambiar interrumpe a todo el mundo, así que se confirma. Poner la primera
  // película en una sala vacía no interrumpe nada: va directa.
  const pick = (item: LibraryItem) => { if (currentTitle) setPending(item); else void apply(item) }

  const rescan = () => {
    setBusy(true)
    setError(null)
    rescanLibrary()
      .then(setItems)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const row = (i: LibraryItem, withFolder: boolean) => (
    <li key={i.id}>
      <button type="button" className="media-btn" disabled={busy} onClick={() => pick(i)}>
        <span className="media-title">
          {i.title}
          {i.title === currentTitle && <span className="media-current"> · en emisión</span>}
        </span>
        <span className="hint">
          {withFolder && <>{i.folderName} · </>}
          {i.srtFiles.length > 0
            ? `${i.srtFiles.length} ${i.srtFiles.length === 1 ? 'subtítulo externo' : 'subtítulos externos'}`
            : 'sin subtítulos externos'}
        </span>
      </button>
    </li>
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* Sin cierre con Escape: en pantalla completa el navegador se queda esa
          tecla para salir del modo y no se puede evitar, así que sería un atajo
          que funciona a medias. Se cierra con el fondo y con la ✕. */}
      <div className="modal media-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" aria-label="Cerrar" onClick={onClose}>✕</button>
        <h2>{currentTitle ? 'Cambiar película' : 'Elegir película'}</h2>

        <input className="emoji-search" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Buscar por título…" aria-label="Buscar película" />

        {error && <p className="field-error">{error}</p>}

        {pending && (
          <div className="media-confirm">
            <p>Vas a cambiar la película <strong>para todos</strong>. La reproducción
              empieza de cero y el chat se conserva.</p>
            <p className="media-title">«{pending.title}»</p>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void apply(pending)}>
              {busy ? 'Poniendo…' : 'Ponerla'}
            </button>
            <button type="button" className="btn-small" disabled={busy} onClick={() => setPending(null)}>
              Cancelar
            </button>
          </div>
        )}

        {items === null ? (
          <p className="gif-picker-status">Cargando la biblioteca…</p>
        ) : items.length === 0 ? (
          <p className="gif-picker-status">No hay vídeos en las carpetas configuradas.</p>
        ) : searching ? (
          results.length === 0
            ? <p className="gif-picker-status">Ningún título coincide.</p>
            : <ul className="media-list">{results.map(i => row(i, true))}</ul>
        ) : (
          <div className="media-folders">
            {folders.map(f => (
              <section key={f.path}>
                <button type="button" className="media-folder" aria-expanded={open === f.path}
                  onClick={() => setOpen(open === f.path ? null : f.path)}>
                  <span>{open === f.path ? '▾' : '▸'} {f.name}</span>
                  <span className="hint">{f.items.length}</span>
                </button>
                {/* Solo la carpeta abierta se renderiza: con cientos de medios,
                    pintarlas todas mete miles de botones en el DOM. */}
                {open === f.path && (
                  <>
                    <p className="hint media-folder-path">{f.path}</p>
                    <ul className="media-list">{f.items.map(i => row(i, false))}</ul>
                  </>
                )}
              </section>
            ))}
          </div>
        )}

        <button type="button" className="btn-small" disabled={busy} onClick={rescan}>
          {busy ? 'Trabajando…' : '↻ Volver a escanear'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Escribir el test de la agrupación**

`groupByFolder` es la única lógica pura del componente y es justo la que arregla el bug de las carpetas homónimas. Crea `web/test/mediaPicker.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { groupByFolder } from '../src/MediaPicker'
import type { LibraryItem } from '../src/types'

const item = (path: string, folderPath: string, folderName: string): LibraryItem =>
  ({ id: path, path, title: path, folderName, folderPath, srtFiles: [] })

describe('groupByFolder', () => {
  it('no fusiona dos carpetas distintas que se llamen igual', () => {
    const groups = groupByFolder([
      item('/m/Alien/Season 1/a.mkv', '/m/Alien/Season 1', 'Season 1'),
      item('/m/Dune/Season 1/b.mkv', '/m/Dune/Season 1', 'Season 1'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.every(g => g.items.length === 1)).toBe(true)
    expect(groups.map(g => g.name)).toEqual(['Season 1', 'Season 1'])
    expect(new Set(groups.map(g => g.path)).size).toBe(2)
  })

  it('agrupa los medios de una misma carpeta y conserva su orden', () => {
    const groups = groupByFolder([
      item('/m/S/1.mkv', '/m/S', 'S'),
      item('/m/S/2.mkv', '/m/S', 'S'),
      item('/m/T/3.mkv', '/m/T', 'T'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].items.map(i => i.path)).toEqual(['/m/S/1.mkv', '/m/S/2.mkv'])
    expect(groups[1].items).toHaveLength(1)
  })

  it('con la biblioteca vacía no devuelve grupos', () => {
    expect(groupByFolder([])).toEqual([])
  })
})
```

- [ ] **Step 3: Ejecutar el test para verificar que pasa**

Run: `npx vitest run test/mediaPicker.test.ts -w web`
Expected: PASS, 3 tests.

- [ ] **Step 4: Montar el modal desde `Room.tsx`**

En `web/src/pages/Room.tsx`, añade la importación y un estado:

```tsx
import { MediaPicker } from '../MediaPicker'
```
```tsx
  const [showPicker, setShowPicker] = useState(false)
```

Botón en la cabecera, solo para el host:

```tsx
          {isHost && (
            <button type="button" className="btn-head" onClick={() => setShowPicker(true)}
              title={info.media ? 'Cambiar la película de la sala' : 'Elegir la película de la sala'}>
              🎬 {info.media ? 'Cambiar película' : 'Elegir película'}
            </button>
          )}
```

Montaje del modal, junto al de `MetaModal`:

```tsx
      {showPicker && (
        <MediaPicker token={token} currentTitle={info.media?.title ?? null}
          by={name} onClose={() => setShowPicker(false)} />
      )}
```

Y en la pantalla de error de ffmpeg, la salida útil cuando un fichero concreto no hay forma de reproducirlo:

```tsx
    return (
      <main className="page">
        <h1>Error al preparar la sala</h1>
        <pre className="error-log">{errorLog.join('\n')}</pre>
        <button className="btn-primary" onClick={retry}>Reintentar</button>
        {isHost && <button className="btn-head" onClick={() => setShowPicker(true)}>🎬 Cambiar película</button>}
        {showPicker && (
          <MediaPicker token={token} currentTitle={info.media?.title ?? null}
            by={name} onClose={() => setShowPicker(false)} />
        )}
      </main>
    )
```

- [ ] **Step 5: Estilos**

En `web/src/theme.css`, añade al final. Se reutilizan `modal-backdrop`, `modal` y `modal-close` de `MetaModal`, así que aquí solo va lo propio del picker y del cartel de espera:

```css
/* El modal del picker: alto acotado y scroll interno, porque la biblioteca
   puede tener cientos de títulos. */
.media-modal {
  width: min(560px, 92vw);
  max-height: min(80vh, 640px);
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  overflow-y: auto;
}
.media-folders { display: flex; flex-direction: column; gap: 0.35rem; }
.media-folder {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
  text-align: left;
}
.media-folder-path {
  margin: 0.1rem 0 0.3rem;
  font-size: 0.7rem;
  word-break: break-all;
}
.media-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.media-btn {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
  text-align: left;
}
.media-title { font-weight: 600; }
.media-current { font-weight: 400; opacity: 0.75; }

/* Confirmación en dos pasos, dentro del modal: un window.confirm nativo puede
   sacar al host de pantalla completa. */
.media-confirm {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.7rem;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.25);
}
.media-confirm p { margin: 0; }

/* Cartel de la sala sin película, en el hueco del vídeo. */
.stage-waiting {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 0.4rem;
  min-height: 40vh;
  padding: 2rem 1rem;
  text-align: center;
  border: 1px dashed color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 10px;
}
.stage-waiting h2 { margin: 0; }
```

**Nota:** el proyecto usa variables CSS y una paleta ámbar propia; si `color-mix` no encaja con el resto del fichero, usa la variable de borde que ya empleen `.folders-box` o `.modal` en lugar de inventar un color.

- [ ] **Step 6: Verificar y commitear**

Run: `cd web && npx tsc --noEmit && cd .. && npm run test -w web && npm run build -w web`
Expected: tsc sin salida, 116 tests en verde, build correcto.

```bash
git add web/src/MediaPicker.tsx web/src/pages/Room.tsx web/src/theme.css web/test/mediaPicker.test.ts
git commit -m "feat: modal para elegir y cambiar la película desde la sala"
```

---

### Task 9: `Library.tsx` — crear sala vacía y agrupar por ruta

**Files:**
- Modify: `web/src/pages/Library.tsx:30-39` (`start`), `:143-186` (render)

**Interfaces:**
- Consumes: `createRoom(itemId?)` (Tarea 6), `LibraryItem.folderPath` (Tarea 1).
- Produces: nada.

- [ ] **Step 1: `start` acepta no llevar película**

En `web/src/pages/Library.tsx`, sustituye `start` (líneas 30-39):

```tsx
  // Sin ítem: sala vacía. El enlace se copia igual, así que el host puede
  // repartirlo y elegir película con la gente ya dentro.
  const start = async (item?: LibraryItem) => {
    try {
      const { token } = await createRoom(item?.id)
      const { tunnelUrl } = await getStatus()
      await navigator.clipboard.writeText(roomLink(tunnelUrl ?? location.origin, token)).catch(() => {})
      location.pathname = `/room/${token}`
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
```

- [ ] **Step 2: Agrupar por `folderPath` y añadir el botón**

Sustituye el bloque final del render (líneas 160-186):

```tsx
  // Por folderPath y no por folderName: dos series con una «Season 1» cada una
  // se fusionarían en una sección con los episodios de ambas mezclados.
  const groups = [...new Map(items.map(i => [i.folderPath, i.folderName])).entries()]
  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">JBG Watchparty</p>
        <h1>La cartelera</h1>
        <div className="marquee-rule" aria-hidden="true" />
      </header>
      <p className="hint">
        <button type="button" className="btn-primary" onClick={() => void start()}>
          🎬 Crear sala vacía
        </button>
        {' '}Reparte el enlace ahora y elige la película dentro de la sala.
      </p>
      {groups.map(([path, name]) => (
        <section key={path} className="bill">
          <h2>{name}</h2>
          <ul className="film-list">{items.filter(i => i.folderPath === path).map((i, idx) => (
            <li key={i.id} style={{ animationDelay: `${Math.min(idx, 10) * 45}ms` }}>
              <button type="button" className="film-btn" onClick={() => void start(i)}>
                <span className="film-title">{i.title}</span>
                <span className="film-go" aria-hidden="true">Crear sala →</span>
              </button>
            </li>
          ))}</ul>
        </section>
      ))}
      <details className="folders-manage">
        <summary>⚙️ Carpetas de medios ({folders.length})</summary>
        {foldersSection}
      </details>
    </main>
  )
```

Y en el estado sin vídeos (línea 143), añade el mismo botón después del `<p>` explicativo, porque crear la sala y repartir el enlace es útil incluso antes de tener biblioteca:

```tsx
        <p>
          <button type="button" className="btn-primary" onClick={() => void start()}>
            🎬 Crear sala vacía
          </button>
        </p>
```

- [ ] **Step 3: Verificar y commitear**

Run: `cd web && npx tsc --noEmit && cd .. && npm run test -w web && npm run build -w web`
Expected: tsc sin salida, tests en verde, build correcto.

```bash
git add web/src/pages/Library.tsx
git commit -m "feat: crear sala vacía desde la cartelera y agrupar por ruta de carpeta"
```

---

### Task 10: Documentación

**Files:**
- Modify: `docs/e2e-checklist.md`
- Modify: `README.md`

- [ ] **Step 1: Casos e2e**

Añade a `docs/e2e-checklist.md` una sección nueva, después de `## Pistas`:

```markdown
## Salas sin película y cambio de película
- [ ] «Crear sala vacía» navega a /room/<token> y copia el enlace público
- [ ] El invitado entra en la sala vacía, pone su nombre y ve el cartel de
      espera; NO ve el botón de elegir película
- [ ] El chat funciona en la sala vacía, en los dos sentidos
- [ ] El host elige película y el vídeo aparece para todos SIN recargar: nadie
      vuelve a poner su nombre y el chat conserva los mensajes anteriores
- [ ] Cambiar de película a mitad de otra, entre dos ficheros con audio y
      subtítulos DISTINTOS: los dos selectores del reproductor listan lo nuevo
- [ ] Tras el cambio no se ve ni un fotograma de la película anterior (es lo que
      comprueba el epoch en la URL: sin él, la caché sirve los segmentos viejos)
- [ ] Tras el cambio la reproducción arranca en 0:00 y en pausa
- [ ] Aparece el mensaje de sistema «<host> puso «<título>»»
- [ ] Cambiar mientras un invitado está en pantalla completa no lo saca de ella
- [ ] Con la película puesta, el picker marca «en emisión» la actual y avisa
      antes de cambiar
- [ ] Copiar un fichero nuevo en la carpeta y darle a «Volver a escanear» dentro
      del picker lo hace aparecer sin reiniciar el servidor
- [ ] Una carpeta con muchos medios (>100): el picker abre solo una carpeta a la
      vez, el buscador filtra y la sala sigue fluida mientras el modal está abierto
- [ ] Dos series con una carpeta «Season 1» cada una salen como DOS secciones,
      tanto en la cartelera como en el picker
```

Y en la sección `## Relevo de vídeo` (créala si no existe, justo después de `## Básico`), el hueco que dejó el commit del relevo:

```markdown
## Relevo de vídeo
- [ ] Con `streamBaseUrl` configurado, las peticiones de vídeo salen por ese
      host y no por el túnel (pestaña Red del navegador: master.m3u8, init_*.mp4
      y seg_*.m4s apuntan al relevo; la API y el WebSocket, al túnel)
- [ ] Los subtítulos se pintan con el vídeo en otro origen (el `crossorigin` del
      <video> es lo que evita que el navegador descarte los <track> en silencio)
- [ ] Sin `streamBaseUrl` todo sale por el mismo origen, como en LAN
```

- [ ] **Step 2: README**

Añade esta sección a `README.md`, junto a donde se explica el uso de las salas (si no hay una sección de uso clara, ponla justo después de la de arranque y antes de la de configuración):

```markdown
## Salas y películas

Una sala y una película son cosas distintas:

- **Crear sala vacía** da un enlace compartible al instante, sin haber elegido
  nada. Los invitados entran, ponen su nombre y pueden **chatear** mientras el
  host decide; en el hueco del vídeo ven un cartel de espera.
- **Solo el host** —quien tiene la cookie de admin, es decir, quien abrió el
  panel en `localhost`— puede poner o cambiar la película, con el botón
  «🎬 Elegir/Cambiar película» de la cabecera de la sala. El play, la pausa y la
  barra de posición siguen siendo de todo el mundo.
- **Cambiar de película** no cierra la sala ni cambia el enlace. Vuelve a probar
  el fichero nuevo, así que **recalcula** duración, pistas de audio, subtítulos
  disponibles y metadatos de TMDB; la reproducción arranca en 0:00 en pausa y el
  **chat se conserva**. Nadie tiene que recargar.

Cada película de una sala es una «generación» numerada, y ese número va en la URL
del vídeo: `/stream/<token>/e2/master.m3u8`. No es decorativo. Los segmentos y el
init se llaman igual en cualquier película (`init_0.mp4`, `seg_0_00000.m4s`), así
que sin versionar la URL la caché del navegador —o la del relevo, si usas
`streamBaseUrl`— serviría los bytes de la película anterior. Va en la ruta y no
en una query para que el versionado no dependa de cómo trate la query el proxy
del relevo, y para que las URIs relativas de las playlists caigan dentro de la
generación correcta por sí solas.
```

- [ ] **Step 3: Verificación final completa y commit**

Run: `npm test && npm run build -w web`
Expected: server y web en verde, build correcto.

```bash
git add docs/e2e-checklist.md README.md
git commit -m "docs: flujo de salas sin película y hueco e2e del relevo"
```

---

## Notas de implementación

**Lo que NO hay que hacer:**
- No tocar `planner.ts`. Si te ves añadiendo un parámetro `epoch` a `buildMasterPlaylist` o `buildMediaPlaylist`, has vuelto al diseño de query string que se descartó: el epoch va en el path precisamente para que las URIs relativas de la playlist caigan dentro de `e<n>/` solas.
- No añadir caché en memoria de la biblioteca. Con un `readdir` por directorio el escaneo ya es barato.
- No implementar «quitar película» (volver a sala vacía). Está fuera de alcance.
- No arreglar la falta de admin en `/retry`. Está fuera de alcance y anotado en el spec.

**Trampa de orden en `setMedia`:** todo lo que puede fallar va antes de `session.stop()`. Si te descubres haciendo `stop()` y luego un `probeFile`, un fichero corrupto deja la sala sin vídeo y sin vuelta atrás.

**Trampa de `stallControl`:** el mapa está indexado por el **objeto** `Room`, cuya identidad se conserva en un cambio de película. Por eso hay que llamar a `attach` otra vez para vaciar el set de buffering; un `refresh` no lo vacía.
