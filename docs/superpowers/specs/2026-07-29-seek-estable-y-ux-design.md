# Seek estable, código de sala en la portada y autoscroll del chat

**Fecha:** 2026-07-29
**Estado:** Aprobado

## Objetivo

Tres arreglos pedidos juntos:

1. **Seek.** Hoy, tras saltar de posición, los espectadores se quedan cargando
   indefinidamente y a menudo solo se ven los subtítulos sobre un vídeo negro.
2. **Código de sala.** Un invitado que abre la URL del túnel sin `/room/…` solo
   ve un texto explicativo; necesita poder pegar el código y entrar.
3. **Autoscroll del chat.** Al llegar un GIF con el historial ya desplazado, la
   lista no baja al fondo.

## Contexto

### Cómo se sincroniza hoy

- El servidor guarda un reloj lógico por sala:
  `PlaybackState { paused, positionBase, updatedAt }`
  (`server/src/rooms/syncState.ts:1-9`). Mientras `!paused`, la posición se
  deriva del tiempo transcurrido: nada la detiene nunca.
- Cada cliente corre un bucle de deriva cada 500 ms
  (`web/src/player/Player.tsx:104-121`): calcula el `target` del reloj de sala
  y, si `|target − currentTime| > 2`, hace `video.currentTime = target`.
- El seek del usuario llega al hub, que aplica el estado nuevo y reinicia
  ffmpeg en el segmento correspondiente (`server/src/ws/hub.ts:110-118`).
- Un único proceso ffmpeg por sala produce segmentos hacia delante desde
  `startSegment` (`server/src/media/transcoder.ts:31-48`). Los clientes piden
  segmentos por HTTP y el servidor espera hasta 30 s a que aparezcan
  (`transcoder.ts:76-87`).

### Por qué falla el seek

Cuatro causas encadenadas, todas confirmadas leyendo el código:

- **El reloj no espera a nadie.** Tras el seek ffmpeg tarda segundos en
  producir el primer segmento, pero el reloj de sala sigue avanzando. El
  `target` se escapa del `currentTime` real, así que cada 500 ms el bucle de
  deriva fuerza otro `video.currentTime = target`, tirando el buffer que
  hls.js estaba llenando. Bucle infinito de «cargando» para todos.
- **Solo se ven los subtítulos** porque los `<track>` son nativos y se pintan
  según `currentTime`, con independencia total del buffer de vídeo. Un
  `currentTime` que salta cada 500 ms sobre un buffer vacío da exactamente
  ese síntoma: subtítulos que avanzan sobre un fotograma congelado.
- **`requestSegment` solo reinicia hacia atrás** (`transcoder.ts:78`). Si el
  reloj se escapó hacia delante, el cliente pide un segmento que ffmpeg no
  está produciendo y el servidor agota los 30 s hasta devolver 504.
- **`init_*.mp4` se reescribe en cada reinicio de ffmpeg.** Un cliente que lo
  pida en ese instante recibe un archivo truncado y no puede decodificar nada
  (`server/src/http/api.ts:110-117` lo sirve con un simple `existsSync`).

### Chat y portada

- El autoscroll es un `useEffect` sobre `state.entries`
  (`web/src/chat/ChatPanel.tsx:29-32`). Cuando corre, la `<img>` del GIF aún
  no ha cargado y mide 0 px: `scrollHeight` es el de antes. Al cargar la
  imagen el contenido crece y ya nadie vuelve a desplazar.
- La portada del invitado es la rama `guest` de
  `web/src/pages/Library.tsx:67-84`, que se muestra cuando `/api/library`
  responde 401. No ofrece ninguna forma de entrar a una sala.

## Decisiones

- **El reloj de la sala puede congelarse, con tope.** Se añade `stalled` al
  estado, distinto de `paused`: `paused` sigue siendo intención del usuario
  (el botón no parpadea), `stalled` es «el grupo espera al que carga». Tope de
  20 s para que una conexión mala no secuestre la sesión.
- **La señal de «listo» se calcula, no se escucha.** El evento `playing` no
  sirve: con el vídeo pausado por `stalled` nunca dispararía y la sala se
  quedaría bloqueada hasta el tope. Se deriva de `video.buffered` en el tick
  que ya existe.
- **`-ss`/`-output_ts_offset` se revisa con evidencia, no a ojo.** Primero un
  test que mide el timestamp real del segmento producido; el cambio a
  `-copyts` solo se aplica si el test demuestra que hace falta.
- **El autoscroll se resuelve por altura, no por evento.** Un
  `ResizeObserver` sobre el contenido cubre de una vez GIF que carga tarde,
  mensaje multilínea y cambio de tamaño del panel, sin enumerar casos.

---

# Bloque A — Seek

## A1. El reloj de la sala puede congelarse

### Estado (`server/src/rooms/syncState.ts` + espejo en `web/src/types.ts`)

`PlaybackState` gana `stalled: boolean` (inicial `false`).

```ts
positionAt(s, now) = (s.paused || s.stalled) ? s.positionBase
                                             : s.positionBase + (now - s.updatedAt) / 1000
```

Dos acciones nuevas en `apply()`:

- `{ type: 'stall'; at }` → `{ ...s, positionBase: positionAt(s, at), stalled: true, updatedAt: at }`
- `{ type: 'resume'; at }` → `{ ...s, stalled: false, updatedAt: at }`
  (`positionBase` ya quedó congelado en el `stall`; `updatedAt` se reajusta
  para que el reloj arranque desde ahora)

`play`, `pause` y `seek` preservan `stalled` tal cual. Como `positionAt`
respeta `stalled`, sus cálculos de `positionBase` siguen siendo correctos sin
cambios adicionales.

No se impide congelar mientras `paused`: la posición ya está congelada por
`paused`, así que es idempotente, y evitarlo añadiría un camino de código
extra (reevaluar al pulsar play) sin ganancia observable.

### Bookkeeping (`server/src/ws/hub.ts`)

Un mapa a nivel de módulo, paralelo a `conns`:

```ts
interface StallInfo { buffering: Set<WebSocket>; timer: NodeJS.Timeout | null; cooldownUntil: number }
const stalls = new Map<Room, StallInfo>()

const STALL_CAP_MS = 20_000
const STALL_COOLDOWN_MS = 10_000
```

Se lleva por socket, no por nombre: dos invitados homónimos no deben pisarse.
El broadcast `{t:'buffering', name, value}` que alimenta la nota «X está
cargando…» no cambia — sigue keyed por nombre, que para un aviso visual basta.

`evaluateStall(room, now)`:

- `want = info.buffering.size > 0 && now >= info.cooldownUntil`
- `want && !room.state.stalled` → aplica `stall`, difunde `state`, arma el
  timer de `STALL_CAP_MS`.
- `!want && room.state.stalled` → aplica `resume`, difunde `state`, limpia el
  timer.

Se llama desde `case 'buffering'` (tras actualizar el `Set`) y desde
`socket.on('close')` (al sacar el socket del `Set`).

Al **expirar el timer**: aplica `resume`, difunde `state`, fija
`cooldownUntil = now + STALL_COOLDOWN_MS` y limpia el timer. El `Set` se deja
como está: si el rezagado no vuelve a emitir un flanco, la sala no se vuelve a
congelar, que es justo lo que se quiere.

`seek` y `play` hacen, en este orden: `cooldownUntil = 0`; si la sala ya
estaba congelada, rearmar el timer con una ventana nueva de 20 s; y llamar a
`evaluateStall`. Los tres pasos hacen falta:

- Sin limpiar el enfriamiento, un seek justo después de agotar el tope no
  obtendría ninguna espera.
- Sin rearmar, un seek heredaría el resto de una ventana vieja en vez de su
  ventana completa.
- Sin reevaluar, el caso «el tope expiró, la sala ya no está congelada, el
  rezagado sigue cargando» no volvería a congelarse nunca: ese cliente ya
  emitió su flanco `buffering:true` y no va a emitir otro.

`closeRoomSockets(room)` limpia el timer y borra la entrada de `stalls`.

## A2. El cliente deja de pelearse con su propio buffer

### `web/src/sync/driftControl.ts`

- `targetPosition` congela con `paused || stalled` (espejo exacto del
  servidor; su `positionAt` local se actualiza igual).
- Función pura nueva:

```ts
export interface Ranges { length: number; start(i: number): number; end(i: number): number }
export function bufferedAhead(ranges: Ranges, t: number): number
```

Devuelve los segundos contiguos disponibles a partir de `t`, o `0` si `t` no
cae dentro de ningún rango. Tolerancia de 0,1 s en el borde inicial para que
un `t` justo en la frontera cuente. Tipada contra una interfaz estructural
para poder testearla con un `TimeRanges` falso.

### `web/src/player/Player.tsx`

Constantes: `READY_AHEAD_S = 2`, `HARD_SEEK_MIN_INTERVAL_MS = 3000`.

- **Se eliminan los listeners `waiting`/`playing`** y el envío de `buffering`
  que colgaba de ellos. La señal pasa a calcularse en el tick de 500 ms:

  ```ts
  const nearEnd = target >= info.durationSec - READY_AHEAD_S
  const ready = nearEnd || bufferedAhead(video.buffered, target) >= READY_AHEAD_S
  ```

  El caso `nearEnd` evita que el final del vídeo —donde nunca habrá 2 s por
  delante— produzca un `buffering` permanente. Se envía `{t:'buffering'}` solo
  en los flancos (cambio true↔false), guardado en un ref.

- **`stalled` se trata como pausa** en el bucle de corrección: `video.pause()`.
  hls.js sigue rellenando buffer estando pausado, así que el rezagado se
  recupera mientras el resto espera quieto en el mismo fotograma.

- **Las correcciones duras se limitan.** `video.currentTime = …` solo si
  `readyState >= HAVE_METADATA` y han pasado ≥ 3 s desde la anterior. Es lo
  que impide que un hipo transitorio se convierta en el bloqueo permanente
  actual. Las correcciones por `playbackRate` no se limitan (no tiran buffer).

- **Un estado nuevo del servidor desbloquea una corrección inmediata.** Un
  efecto con dependencia `[lastState?.state.updatedAt]` pone el ref del
  throttle a 0, para que el seek que acaba de pedir el usuario se aplique al
  instante en vez de esperar hasta 3 s. El throttle solo debe frenar al bucle
  de deriva, nunca a una orden explícita.

## A3. `init_*.mp4` estable

`TranscodeSession.requestInit(variant, timeoutMs = 30_000): Promise<string>`:

- Si existe `init_<v>.stable.mp4`, lo devuelve.
- Si no, espera a que `init_<v>.mp4` exista **y** haya aparecido
  `seg_<v>_<startSegment>.m4s` (o el proceso haya terminado). El muxer HLS
  escribe y cierra el init antes de finalizar el primer segmento, así que la
  presencia del segmento —que con `temp_file` solo aparece ya completo— basta
  como prueba de que el init está entero.
- Copia a un `.tmp` único por llamada y hace `renameSync` al nombre estable.
  Dos peticiones concurrentes producen copias idénticas y el rename atómico
  deja una cualquiera; no hay resultado incorrecto posible.
- Agotado el plazo, lanza (el endpoint traduce a 504).

`SessionLike` (`server/src/rooms/roomManager.ts:14-21`) gana `requestInit`.

`api.ts` sustituye el `existsSync` del bloque `init_(\d+)\.mp4` por
`await room.session.requestInit(variant)` dentro de try/catch, igual que ya
hace con los segmentos.

`RoomManager.retry()` borra los `init_*.stable.mp4` del `roomDir` antes de
crear la sesión nueva: un snapshot de una ejecución rota no debe sobrevivir al
reintento.

`pickPrunable`/`segmentFilesWithStats` solo tocan `.m4s`
(`server/src/media/cachePrune.ts:19`), así que la poda de caché no puede
borrar el snapshot. No requiere cambios.

## A4. Reinicio hacia delante

En `requestSegment`, con `FORWARD_GRACE_MS = 6_000`: si tras la gracia el
segmento sigue sin estar listo, `index > startSegment` y **tampoco existe
`index - 1`** (prueba de que ffmpeg no viene de camino), se hace
`seekTo(index)` una única vez por llamada y se sigue esperando. Sustituye a
agotar los 30 s hasta el 504.

Guarda nueva en `seekTo`, **antes** de la comprobación de región cacheada:

```ts
// Ya estamos produciendo desde ahí: matar el proceso que justo está llenando
// ese hueco solo reiniciaría el trabajo. Sin esto, las peticiones de vídeo y
// de audio del mismo índice se matarían mutuamente en bucle.
if (segmentIndex === this.startSegment && this.proc && this.proc.exitCode === null) return
```

Protege también el camino hacia atrás existente y el seek del usuario a la
posición en la que ffmpeg ya está trabajando.

## A5. Timestamps tras el seek: medir antes de cambiar

`-output_ts_offset T` asume que ffmpeg cae **exactamente** en el keyframe `T`.
Si cae en el anterior (`T'`), el medio declara empezar en `T` pero contiene
desde `T'`: desfase permanente entre el `tfdt` y la playlist. `-copyts` no
asume nada —conserva el tiempo absoluto de la fuente—, de modo que todos los
reinicios comparten una única línea de tiempo global y ninguno puede
contradecir a otro.

**Primero el test** (`server/test/transcoder.test.ts`): arrancar la sesión en
un segmento intermedio del fixture, concatenar `init_0.mp4 + seg_0_<mid>.m4s`
en un `.mp4` temporal y leer con ffprobe
`-select_streams v:0 -show_entries stream=start_time`; afirmar que coincide
con `segments[mid].start` dentro de ~0,1 s.

- Si el código actual pasa, se queda como está y el test queda como regresión.
- Si falla, se sustituye `-output_ts_offset` por `-copyts` en
  `server/src/media/ffmpegArgs.ts` y el mismo test valida el cambio. Si
  `-copyts` por sí solo no bastara, la variante a probar es
  `-copyts -avoid_negative_ts disabled`. `-start_at_zero` queda descartado:
  deshace justo lo que se busca.

**Si se adopta `-copyts`, `-force_key_frames` debe reanclarse.** Hoy es
`expr:gte(t,n_forced*4)` (`ffmpegArgs.ts:24`), que da por hecho que `t`
arranca en 0. Con timestamps absolutos, `n_forced*4` iría muy por detrás del
`t` real y forzaría un keyframe en cada fotograma. Pasa a
`expr:gte(t,n_forced*4+${seg.start})`. Es correcto porque en modo transcode
`keyframes` es `null` y `planSegments` reparte cada 4 s
(`server/src/media/planner.ts:12`), así que `seg.start` siempre es múltiplo
de 4.

## Tests del bloque A

- `server/test/syncState.test.ts`: `stall` congela la posición; `resume`
  reanuda desde donde se congeló; `play`/`pause`/`seek` preservan `stalled`.
- `server/test/hub.test.ts`: un `buffering:true` congela la sala y difunde
  `state` con `stalled:true`; el `buffering:false` del último rezagado la
  reanuda; el cierre del socket de quien estaba cargando también reanuda; con
  timers falsos, pasados 20 s la sala se reanuda sola y un `buffering:true`
  inmediato posterior no la vuelve a congelar (enfriamiento); un `seek`
  limpia el enfriamiento.
- `server/test/transcoder.test.ts`: `requestInit` devuelve el snapshot estable
  y sobrevive a un reinicio de ffmpeg; `seekTo(startSegment)` con proceso vivo
  no reinicia; el test de timestamps de A5.
- `web/test/driftControl.test.ts`: `bufferedAhead` (dentro de un rango, entre
  rangos, sin rangos, en la frontera); `targetPosition` congelado con
  `stalled:true` y `paused:false`.

---

# Bloque B — Código de sala en la portada del invitado

## `web/src/pages/roomToken.ts` (nuevo)

```ts
export function parseRoomToken(input: string): string | null
```

Acepta el código pelado o un enlace completo pegado: si la entrada contiene
`/room/<algo>`, se queda con ese `<algo>`; si no, con la entrada recortada.
Devuelve el token solo si encaja con `/^[\w-]{8,}$/` (los tokens reales son 22
caracteres base64url, `randomBytes(16)` en
`server/src/rooms/roomManager.ts:56`, y el enrutado de `web/src/App.tsx:5` usa
`[\w-]+`); en cualquier otro caso, `null`.

## `web/src/pages/Library.tsx`

En la rama `guest`, bajo el texto explicativo: un `<form className="name-form">`
con input («Código o enlace de la sala») y botón «Entrar». Al enviar:

- `parseRoomToken` devuelve `null` → error en línea con `.field-error` y no se
  navega.
- Token válido → `location.pathname = '/room/' + token`.

Una sala inexistente ya cae en la pantalla «Sala no encontrada» de
`Room.tsx:105-116`; no hace falta validar contra el servidor antes de navegar.

## Tests del bloque B

`web/test/roomToken.test.ts`: token pelado, URL completa con y sin barra
final, URL con `?query`, cadena vacía, texto arbitrario, token demasiado
corto.

---

# Bloque C — Autoscroll del chat

## `web/src/chat/ChatPanel.tsx`

Los hijos de `.chat-entries` pasan a un `<div className="chat-entries-inner">`.
Un `ResizeObserver` sobre ese wrapper hace `el.scrollTop = el.scrollHeight`
en cada cambio de altura del contenido, y sustituye al
`useEffect([state.entries])` actual.

Baja siempre, sin condición de «solo si ya estabas abajo», tal como se pidió.

Cubre en un solo mecanismo el GIF que carga después de renderizar (causa del
fallo reportado), el mensaje multilínea y el cambio de tamaño al entrar o
salir de modo teatro.

## `web/src/theme.css`

`display:flex`, `flex-direction:column` y `gap:0.45rem` se mueven de
`.chat-entries` (línea 914) a `.chat-entries-inner`. El contenedor externo
conserva `flex:1`, `min-height`, `max-height`, `overflow-y`, bordes, padding y
`overscroll-behavior`, de modo que la regla de modo teatro
`.room-grid--theater .chat-entries { max-height }` (línea 726) sigue valiendo
sin tocarla.

## Verificación del bloque C

Los tests de `web` corren en entorno node, sin DOM (`web/vitest.config.ts`),
así que este bloque no lleva test automatizado: no hay lógica pura que aislar
más allá de `scrollTop = scrollHeight`. Se comprueba a mano en la sala,
enviando un GIF con el historial ya desplazado hacia arriba.

---

## Fuera de alcance

- Múltiples calidades/renditions de vídeo o transcodificación adaptativa.
- Más de un proceso ffmpeg por sala (p. ej. para servir a espectadores en
  posiciones distintas).
- Precarga o transcodificación anticipada de la película completa.
- Persistencia del chat o del historial de salas.
- Campo de código de sala en la pantalla «Sala no encontrada» de `Room.tsx`.
- Comportamiento «pegado al fondo solo si ya estabas abajo» en el chat.
