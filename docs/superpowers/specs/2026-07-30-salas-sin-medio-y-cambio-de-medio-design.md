# Salas sin película y cambio de película en caliente

**Fecha:** 2026-07-30
**Estado:** Aprobado

## Objetivo

Desacoplar la sala de la película:

1. El host puede **crear una sala vacía**, sin haber elegido nada. El enlace ya
   es compartible y los invitados que entren ven que el host está eligiendo,
   con el chat funcionando mientras esperan.
2. El host puede **cambiar la película dentro de la sala**, sin cerrarla ni
   repartir un enlace nuevo.
3. Cada cambio **recalcula** duración, pistas de audio, subtítulos disponibles y
   metadatos de TMDB, y los sirve a todos los clientes sin que nadie recargue.

## Contexto

- `Room` mezcla hoy la identidad de la sala (token, chat, estado de
  reproducción, listeners) con todo lo que depende del fichero: `item`, `info`,
  `segments`, `subtitles`, `session`, `meta`, `roomDir`
  (`server/src/rooms/roomManager.ts:31-46`). Esa mezcla es exactamente lo que
  hace imposible una sala sin película.
- `RoomManager.create(item)` hace en un solo paso: `mkdir`, `probeFile`,
  `pickMode`, `extractKeyframes`, `planSegments`, `listSubtitleOptions` +
  `extractSubtitle` por pista, `lookupMeta`, `enrichAudioLangs`,
  `createSession` y `session.start()` (`roomManager.ts:63-93`).
- `RoomManager.retry(token)` ya hace el 90% de un cambio de película: para la
  sesión, borra `*.m4s` / `init_*` / `*.stable.mp4` del `roomDir`, replanifica
  la rejilla y arranca una sesión nueva (`roomManager.ts:98-124`). Lo que le
  falta es re-probar otro fichero y regenerar subtítulos y metadatos.
- El cliente reacciona hoy a un fallo de ffmpeg con `location.reload()`
  (`web/src/pages/Room.tsx:236-240`).
- `conns` (`server/src/ws/hub.ts:12`) y el mapa de `stallControl`
  (`server/src/rooms/stallControl.ts:18`) están **indexados por el objeto
  `Room`**, no por token. Si la identidad del objeto se conserva, los sockets y
  los participantes sobreviven a un cambio de película: eso es lo que hace
  posible el refresco suave.
- `stallControl` solo lee `room.state` por diseño explícito
  (`stallControl.ts:8-9`), así que funciona igual en una sala sin película.
- Las URLs de segmentos e inits **no dependen del fichero**: `init_0.mp4` y
  `seg_0_00000.m4s` se llaman igual en cualquier película
  (`server/src/media/planner.ts:65-75`, `server/src/media/transcoder.ts:98-100`).
- El plano de datos puede vivir en **otro origen**: `streamBaseUrl` saca el vídeo
  por un relevo propio (Caddy con `reverse_proxy` sobre WireGuard,
  `README.md:184-187`) mientras HTML, API y WebSocket siguen por el túnel
  (`server/src/config.ts`, commit `0044371`). `GET /api/rooms/:token` ya devuelve
  ese origen como `streamBase` (`server/src/http/api.ts:79-83`), y `/stream`
  responde `access-control-allow-origin: *` **antes de cualquier otra
  comprobación**, incluido el 404 de sala inexistente (`api.ts:98-121`): un error
  cross-origin sin esas cabeceras se lo traga el navegador en silencio.
- `web/src/player/streamUrl.ts` ya compone las URLs del plano de datos
  (`streamUrl(base, token, file)`), y el efecto de hls.js ya depende de
  primitivas y no del objeto `info`, precisamente porque ese objeto llega nuevo
  de cada fetch de la sala y remontaría el reproductor sin motivo
  (`web/src/player/Player.tsx:169-171`).
- `requestInit` espera hasta 30 s a que aparezca un init
  (`transcoder.ts:126-154`); una petición de una generación ya muerta se
  quedaría colgada todo ese plazo.
- El único mecanismo de identificación del host es la cookie `admin`
  (`server/src/http/security.ts:18-29`). `/api/library` y `/api/status`
  responden 401 a los invitados; el cliente ya deduce «soy el host» de que
  `/api/status` no dé 401 (`Room.tsx:155-173`).
- Play/pausa/seek son de **todos** los participantes, no solo del host
  (`docs/e2e-checklist.md`: «La barra está disponible para el invitado»).
- La poda de caché recorre `r.roomDir` de cada sala viva
  (`server/src/index.ts:28-32`).
- `POST /api/rooms/:token/retry` **no** exige admin hoy
  (`server/src/http/api.ts:85-94`).

## Decisiones

- **`Room` se parte en `Room` + `RoomMedia`.** La alternativa —dejar los campos
  del fichero en `Room` y hacerlos opcionales uno a uno— repartiría media docena
  de `!` y `?.` por `api.ts` y `hub.ts` sin ninguna garantía de coherencia entre
  ellos. Con un solo `media: RoomMedia | null`, una sola comprobación protege el
  grupo entero.
- **Un contador `epoch` por sala, incremental, empezando en 1.** Versiona las
  URLs de `/stream` y sirve de `key` para remontar el `<Player>`.
- **El epoch va en el path: `/stream/<token>/e<n>/<file>`.** No es cosmético: sin
  versionar, la caché del navegador —y la del relevo— servirían los bytes de
  `init_0.mp4` y `seg_0_00000.m4s` de la película anterior, porque esos nombres
  son idénticos en cualquier película. En el path y no en una query (`?e=`) por
  dos razones: **`planner.ts` no se toca en absoluto**, porque hls.js resuelve
  los nombres relativos de una playlist contra la URL de esa playlist y todos
  caen dentro de `e<n>/` solos —el mismo truco que ya hace funcionar el relevo—;
  y así el versionado no depende de que un proxy que no se configura desde este
  repo reenvíe la query ni de cómo calcule su clave de caché.
- **Un subdirectorio de caché por epoch** (`<cacheDir>/<token>/e<n>/`) en vez de
  reutilizar el mismo directorio. Evita una carrera real: un cliente
  descargando `seg_0_00042.m4s` de la película anterior mientras el ffmpeg nuevo
  escribe un fichero con ese mismo nombre. Con directorios separados los
  ficheros viejos quedan huérfanos y se borran aparte.
- **Refresco suave, no recarga de página.** El servidor difunde
  `{t:'media', epoch}`, el cliente vuelve a pedir `GET /api/rooms/:token` y el
  `<Player>` se remonta por `key`. Se conservan chat, nombre, pantalla completa,
  volumen y scroll. Descartada la recarga (parpadeo, pérdida de pantalla
  completa, y N clientes golpeando el arranque de ffmpeg a la vez) y descartado
  cerrar y recrear la sala con token nuevo (mata el enlace compartido, que es
  justo lo que se quiere conservar).
- **Solo el host cambia la película.** No es una preferencia estética: el
  selector necesita `/api/library`, y abrirlo a los invitados expondría los
  nombres de todos los ficheros del disco del host a cualquiera con el enlace
  público. Play/pausa/seek siguen siendo de todos.
- **El chat sobrevive al cambio.** La sala es la misma fiesta. Se añade un
  mensaje de sistema anunciando la película nueva.
- **La reproducción se resetea a 0:00 en pausa.** No se recuerda la posición de
  la película anterior por si se vuelve a poner.
- **`create(item?)` con película pasa a ser `create()` + `setMedia()`.** Es la
  forma de no tener dos copias de la secuencia probe → plan → subtítulos → meta
  → sesión.
- **Preparar-luego-conmutar.** Todo lo que puede fallar (validación, probe,
  plan, subtítulos, TMDB) ocurre antes de tocar la sesión viva, así que un
  fichero corrupto deja la sala con la película anterior funcionando. Y la
  sesión vieja se para **antes** de arrancar la nueva, así que nunca hay dos
  ffmpeg compitiendo por la CPU.
- **Un cambio a la vez, con 409.** El host es una sola persona; un sistema de
  cerrojos encadenados no se paga.
- **Epoch obsoleto → 410 Gone, no 404.** Durante la transición la instancia vieja
  de hls.js aún pide URLs de la generación anterior. Sin esta comprobación
  explícita, `requestInit` las dejaría colgadas 30 s esperando un fichero de un
  directorio ya borrado.
- **La autenticación de `retry` no se toca.** Es un agujero preexistente
  (cualquier invitado puede reintentar); arreglarlo aquí sería ampliar el
  alcance por la puerta de atrás. Queda anotado.

## Diseño

### 1. Modelo de datos (`server/src/rooms/roomManager.ts`)

```ts
export interface RoomMedia {
  epoch: number                    // 1, 2, 3…
  item: LibraryItem
  info: MediaInfo
  segments: Segment[]
  subtitles: SubtitleOption[]
  meta: RoomMeta | null
  session: SessionLike
  dir: string                      // <cacheDir>/<token>/e<epoch>
}

export interface Room {
  token: string
  dir: string                      // <cacheDir>/<token>, se borra al cerrar
  media: RoomMedia | null
  state: PlaybackState
  chat: ChatEntry[]
  error: string[] | null
  busy: boolean                    // un setMedia/retry en vuelo
  errorListeners: Set<(log: string[]) => void>
  closeListeners: Set<() => void>
  mediaListeners: Set<(media: RoomMedia) => void>
}
```

`mediaListeners` sigue el patrón exacto de `errorListeners` y `closeListeners`:
`RoomManager` no conoce el hub, así que notifica y el hub decide qué difundir.

### 2. `RoomManager`

- **`create(item?: LibraryItem): Promise<Room>`**
  Crea token, `dir` (`mkdirSync` recursivo), `media: null`, `state:
  initialState(now)`, chat vacío. **Sin probe y sin ffmpeg.** Si llega `item`,
  llama a `setMedia` antes de devolver, de modo que la ruta con película sea
  literalmente la misma que la del cambio.

- **`setMedia(token: string, item: LibraryItem): Promise<RoomMedia>`**
  En este orden exacto:
  1. Si `room.busy`, lanza `RoomBusyError`.
  2. `room.busy = true` (con `try/finally` para soltarlo siempre).
  3. `epoch = (room.media?.epoch ?? 0) + 1`; `dir = join(room.dir, 'e' + epoch)`;
     `mkdirSync`.
  4. `probeFile(item.path)` → `pickMode(info)` → `extractKeyframes` solo en modo
     `copy` → `planSegments`.
  5. `listSubtitleOptions(info, item.srtFiles)` y `extractSubtitle` de cada una
     dentro de `dir` (misma tolerancia a fallo que hoy: `.catch(() => {})`).
  6. `lookupMeta(item.title)` y `enrichAudioLangs(...)`.
     — **Hasta aquí nada de la sala se ha tocado.** Cualquier excepción propaga
     y la sala sigue exactamente como estaba, con su película anterior en
     marcha; antes de propagar se borra el `dir` a medio construir.
  7. `await room.media?.session.stop()`.
  8. `createSession(item, info, segments, dir, mode)`, registrar `onError` (fan-out
     a `errorListeners`, igual que hoy) y `session.start()`.
  9. `room.media = nuevo`; `room.state = initialState(Date.now())`;
     `room.error = null`.
  10. Borrar el directorio del epoch anterior. Best-effort: en Windows un
      fichero con un descriptor abierto hace fallar el `rmSync`; se ignora y se
      va con el `dir` de la sala al cerrarla.
  11. Notificar `mediaListeners`.

- **`retry(token)`** — lanza `RoomBusyError` si `busy`. Sin película es un
  no-op silencioso: el endpoint ya rechaza ese caso con 409 antes de llamar, y
  esto es solo la segunda barrera. Por lo demás igual que hoy, operando sobre
  `room.media` (su borrado
  selectivo de `*.m4s` / `init_*` / `*.stable.mp4` conservando `sub_*.vtt` sigue
  siendo correcto: opera dentro de `media.dir`).

- **`close(token)`** — tolera `media === null`; borra `room.dir` completo (con
  todos los subdirectorios de epoch).

### 3. API HTTP (`server/src/http/api.ts`)

- `POST /api/rooms` — cuerpo `{ itemId?: string }`. Sin `itemId`, crea sala
  vacía. Con `itemId`, mismas validaciones que hoy (ítem en biblioteca +
  `isPathInside` de `mediaFolders`). Sigue exigiendo admin.
- `POST /api/rooms/:token/media` — **nuevo**, con `preHandler: requireAdmin`.
  Cuerpo `{ itemId: string; by?: string }`. Repite las dos validaciones de
  `POST /api/rooms`; **no** se heredan, y sin ellas el endpoint sería un lector
  arbitrario de ficheros para quien tenga la cookie. Respuestas: `404` sala o
  ítem inexistente, `400` ruta fuera de `mediaFolders`, `409` `RoomBusyError`,
  `500` fallo de probe (sala intacta), `200 { epoch }`. Además,
  `lastRetryAt.delete(token)`: el enfriamiento de reintento de la película
  anterior no debe aplicarse a la nueva.
- `GET /api/rooms/:token` — público, sigue devolviendo `404` solo si la sala no
  existe. Forma nueva:
  ```ts
  interface RoomMediaInfo { epoch: number; title: string; durationSec: number
    audio: AudioTrack[]; subtitles: SubtitleOption[]; meta: RoomMeta | null }
  interface RoomInfo { media: RoomMediaInfo | null; error: string[] | null
    streamBase: string }
  ```
  Con `media: null`, `error` es siempre `null` (el error solo lo produce ffmpeg,
  que solo existe con película). `streamBase` **se queda al nivel superior**, no
  dentro de `media`: describe dónde vive el servidor, no la película, y el
  cliente lo necesita igual en una sala vacía.
- `GET /stream/:token/:epoch/:file` — la ruta gana un segmento, y el
  `app.options` de CORS (`api.ts:112-117`) gana el mismo. `404` en todo si
  `media === null`. El resto igual, leyendo de `room.media`: `info.audio`,
  `segments`, `session`, y `sub_N.vtt` desde `media.dir`. Comprobación de epoch
  nueva, una sola vez al principio del handler y por tanto válida para **todos**
  los ficheros (playlists, inits, segmentos y subtítulos):
  - `:epoch` que no encaje con `/^e(\d+)$/` → `404`: nunca fue una URL nuestra.
  - encaja pero su número no es `media.epoch` → `410`: existió y ya no.

  Va **después** de `allowCors(reply)`. Un 410 cross-origin sin cabeceras CORS es
  un fallo mudo, que es justo lo que ese `allowCors` de la primera línea existe
  para evitar. La ruta vieja de dos segmentos desaparece: el cliente siempre
  construye la versionada.
- `POST /api/rooms/:token/retry` — `409` si `media === null` o si `busy`.
  Autenticación sin cambios.
- `GET /api/status` — `rooms: [{ token, title }]` con `title: 'Sin película'`
  cuando `media === null`.

### 4. Playlists (`server/src/media/planner.ts`): sin cambios

Las URIs que emite siguen siendo relativas (`video.m3u8`, `audio_N.m3u8`,
`#EXT-X-MAP:URI="init_0.mp4"`, `seg_V_NNNNN.m4s`) y el navegador las resuelve
contra la URL de la playlist que las contiene, que ya cuelga de `…/e<n>/`. Con el
epoch en el path el versionado se propaga sin que `planner.ts` sepa que existe.
Las expresiones regulares de `:file` en `/stream` (`api.ts:110-141`) tampoco
cambian.

### 5. WebSocket (`server/src/ws/messages.ts`, `server/src/ws/hub.ts`)

- `ServerMsg` gana `{ t: 'media'; epoch: number }`.
- `play` / `pause` / `seek`: **return temprano** si `media === null` — sin
  broadcast y sin mensaje de sistema. `seek` clampa con
  `room.media.info.durationSec` y usa `room.media.segments` /
  `room.media.session`.
- `join` / `chat` / `gif` / `reaction` / `visibility` / `buffering`: funcionan
  igual sin película. Eso es lo que hace útil la sala vacía: la gente entra,
  pone su nombre y charla mientras el host elige.
- Al registrar la sala en `conns` por primera vez, el hub añade también su
  `mediaListener`, junto a los de error y cierre (`hub.ts:56-64`). Ese listener:
  1. `stall.attach(room, …)` otra vez. **Imprescindible**: `attach` hace
     `detach` primero (`stallControl.ts:22-25`), así que el set de `buffering`
     nace vacío. Sin esto, un socket que quedó marcado como «cargando» en la
     película anterior congelaría la nueva desde el primer play, y no volvería a
     emitir ningún flanco que lo saque del set.
  2. `broadcast({ t: 'media', epoch })`.
  3. `broadcast({ t: 'state', state: room.state, serverNow: now })`.
  4. `system(room, …)` con el mensaje de sistema.
- **Autoría del mensaje de sistema.** El servidor no puede saber que la cookie
  de admin corresponde al participante «Jaime»: son dos canales distintos. El
  navegador del host manda su propio nombre en el `by?` del POST (lo conoce por
  su `welcome`), y el mensaje sale como «Jaime puso «Alien»»; sin `by`, respaldo
  impersonal «ahora se ve «Alien»». Como el endpoint exige admin, `by` no abre
  ningún vector que el host no tenga ya.

### 6. Poda de caché (`server/src/index.ts`)

`rooms.all().flatMap(r => r.media ? segmentFilesWithStats(r.media.dir) : [])`.
Las salas vacías no aportan ficheros y los epochs huérfanos que no se hayan
podido borrar quedan fuera de la poda: se los lleva `close()`.

### 7. Cliente

#### `web/src/types.ts`
Espejo manual de `RoomInfo` / `RoomMediaInfo` y del `ServerMsg` nuevo, como se
viene haciendo (no hay dependencia cruzada entre workspaces). `streamBase`
sobrevive donde está, al nivel superior de `RoomInfo`.

#### `web/src/api.ts`
- `createRoom(itemId?: string)` — omite `itemId` del cuerpo si no llega.
- `setRoomMedia(token, itemId, by?)` — `POST /api/rooms/:token/media`.

#### `web/src/player/streamUrl.ts` (ya existe, se extiende)
`streamUrl(base, token, file)` pasa a `streamUrl(base, token, epoch, file)` y
compone `<base>/stream/<token>/e<epoch>/<file>`. El recorte de barras finales y
el trato de `null`/`undefined` como mismo origen se quedan intactos: sus tests
los cubren y siguen siendo correctos.

#### `web/src/pages/Library.tsx`
`start(item?)`: sin ítem crea sala vacía. Botón «🎬 Crear sala vacía» en la
cabecera de la cartelera y también en el estado sin vídeos (donde es justo la
salida útil: crear la sala y repartir el enlace mientras se configuran las
carpetas). Los botones por ítem se quedan como están.

#### `web/src/pages/Room.tsx`
- `isHost: boolean` explícito, puesto en el `.then` del sondeo de `/api/status`
  y a `false` en su `catch` de 401. Es la señal que ya existe, solo con nombre.
- `info.media === null` → se conserva la rejilla y el `ChatPanel`, y el hueco
  del vídeo lleva el cartel «El host está eligiendo la película». Si `isHost`,
  además el botón «🎬 Elegir película».
- `{t:'media'}` → refetch de `getRoom(token)` y `setWsError(null)`. **También
  para el host que lo provocó**: el `POST` no actualiza estado por su cuenta, así
  que hay un único camino de refresco en vez de dos que puedan divergir.
- `<Player key={info.media.epoch} media={info.media} streamBase={info.streamBase} …>`.
- La puerta del nombre usa `info?.media?.title ?? 'la función'`; el botón de
  Info y el `MetaModal` se guardan con `info.media?.meta`.
- En la pantalla de error de ffmpeg, si `isHost`, aparece «Cambiar película»
  junto a «Reintentar», abriendo el mismo `MediaPicker`: es la salida útil
  cuando un fichero concreto no hay forma de reproducirlo.

#### `web/src/MediaPicker.tsx` (nuevo)
Modal que pide `/api/library`, agrupa por carpeta como la cartelera y filtra
por título. Al elegir, `setRoomMedia`. Si ya hay película puesta, confirma antes
(«Vas a cambiar la película para todos»). Cierre por clic en el fondo y botón
`✕`, como `MetaModal`; sin Escape, por el mismo motivo documentado en el spec de
emojis. Muestra el error del servidor en el propio modal (404/400/409/500) sin
cerrarse, para poder elegir otra cosa.

#### `web/src/player/Player.tsx`
- Prop `info: RoomInfo` pasa a `media: RoomMediaInfo` más `streamBase: string`
  aparte, porque `streamBase` no vive dentro de `media`.
- Las dos URLs que construye el propio componente ya van por `streamUrl`
  (`master.m3u8` y los `<track src>` de `sub_N.vtt`): solo se les añade el epoch.
  Las internas de las playlists las resuelve el navegador relativas al master.
- Las dependencias del efecto de hls.js pasan a `[token, streamBase, epoch]`,
  todas primitivas. Es la regla que el fichero ya sigue y documenta: el objeto de
  la sala llega nuevo de cada fetch y remontaría hls.js sin motivo. El remonte por
  `key={epoch}` sí es intencionado y debe ocurrir.
- `crossOrigin` sigue gobernado por `streamBase`, sin cambios.

## Tests

Sigue la línea del proyecto: funciones puras y endpoints con `app.inject`, no
componentes.

- **`server/test/roomManager.test.ts`**
  - `create()` sin ítem: `media === null`, no se llama a `createSession`, no se
    ejecuta probe.
  - `setMedia` puebla `info`, `segments`, `subtitles`, `meta`, sube `epoch` a 1 y
    resetea `state` a pausa en 0.
  - Segundo `setMedia`: `epoch` 2, sesión anterior parada, directorio `e1`
    borrado, `e2` con los `sub_*.vtt` nuevos.
  - `setMedia` con un ítem cuyo fichero no se puede probar: rechaza y la sala
    conserva `media` anterior intacto (misma sesión, mismo epoch).
  - `setMedia` concurrente: el segundo rechaza con `RoomBusyError`.
  - `retry` es no-op sin película; `close` funciona sin película.
  - Los tests existentes migran a `room.media!.*` (hoy usan `room.segments`,
    `room.info`, `room.roomDir`).
- **`server/test/api.test.ts`**
  - `POST /api/rooms` sin `itemId` → 200 con token; `GET` devuelve
    `media: null, error: null`.
  - `POST /api/rooms/:token/media` sin cookie de admin → 401.
  - Con ítem fuera de `mediaFolders` → 400; ítem inexistente → 404; sala
    inexistente → 404.
  - Cambio correcto → 200 `{epoch: 2}`, y `GET` refleja la duración, las pistas
    de audio y los subtítulos **de la película nueva**.
  - `/stream/:token/e1/*` → 404 en todas sus formas con `media === null`.
  - Un `e<n>` de una generación anterior → 410, **con las cabeceras CORS
    puestas**; un `:epoch` con forma inválida (`3`, `x1`) → 404.
  - `/api/status` muestra «Sin película» para la sala vacía.
- **`server/test/hub.test.ts`**
  - `play` y `seek` en sala sin película no difunden nada ni escriben en el chat.
  - `chat` sí funciona en sala sin película.
  - Un `setMedia` difunde `{t:'media', epoch}`, `{t:'state'}` con posición 0 en
    pausa, y el mensaje de sistema con el título.
  - Un participante marcado como «cargando» antes del cambio no deja la sala
    nueva congelada tras el primer `play`.
- **`web/test/streamUrl.test.ts`** (ya existe, se amplía) — el epoch aparece en el
  path, y un nombre relativo resuelto contra el master versionado cae dentro de
  `e<n>/`: es la prueba de que `planner.ts` puede seguir sin saber que el epoch
  existe. `planner.test.ts` no cambia.
- **`docs/e2e-checklist.md`** — sección manual nueva: crear sala vacía y copiar
  el enlace antes de elegir; el invitado entra y ve el cartel de espera y puede
  chatear; el host elige y el vídeo aparece para todos sin recargar; cambiar de
  película a mitad de otra (con audio y subtítulos **distintos**) y comprobar que
  los dos selectores del reproductor listan lo nuevo y que no se ve ni un
  fotograma de la anterior; que el chat sobrevive; que el invitado no ve el botón
  de cambiar; y que cambiar mientras alguien está en pantalla completa no lo saca
  de ella.

## Fuera de alcance

- **Quitar la película y volver a sala vacía** sin cerrarla.
- Recordar la posición de una película al volver a ponerla.
- Cola o lista de reproducción de varias películas.
- Que los invitados elijan o voten la película.
- Persistencia de salas entre reinicios del servidor.
- Arreglar que `POST /api/rooms/:token/retry` no exija admin (agujero
  preexistente, anotado en Contexto).
- Cambiar la maquetación o los controles del reproductor.
