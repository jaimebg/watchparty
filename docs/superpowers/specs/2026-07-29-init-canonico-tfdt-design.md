# Init fMP4 canónico y `tfdt` absoluto: seek fiable en cualquier posición

**Fecha:** 2026-07-29
**Estado:** Aprobado

## Objetivo

Cerrar la «Known limitation» de `bb67bc0`: un salto de posición solo aterriza
bien mientras la sala siga corriendo sobre el proceso de ffmpeg que produjo el
init fijado. Después del primer reinicio, los segmentos nuevos se colocan en el
offset del init viejo y el vídeo aparece al principio de la película.

Con eso resuelto, devolver el seek a la interfaz: barra arrastrable, y
disponible para todos los espectadores, no solo para el host.

## Contexto

El servidor sirve HLS fMP4 VOD. `requestInit` fija **un** snapshot de
`init_V.mp4` para toda la vida de la sala (`transcoder.ts:113`), porque ffmpeg
reescribe ese archivo entero en cada reinicio y un cliente que lo pille a medias
se lleva un init truncado. Cada seek reinicia ffmpeg con `-ss` + `-copyts`
(`ffmpegArgs.ts:25`).

### Medición

Fuente sintética de 60 s, rejilla de 4 s, con las funciones reales del repo
(`planSegments` + `buildTranscodeArgs`, encoder `h264_videotoolbox`), arrancando
desde 0 (run A) y reiniciando en el segmento 5 = 20 s (run B):

| | `elst` del init (empty edit) | `tfdt` del segmento 5 |
|---|---|---|
| Run A (desde 0) | vídeo `dur=23` ms, audio ninguno | 256000 = **20,000 s** |
| Run B (`-ss 20 -copyts`) | vídeo `dur=20000`, audio `dur=19953` | **0** |

Es decir: **el run reiniciado guarda su posición absoluta en el edit list del
init y pone el `tfdt` a cero**. Como el init fijado es el del run A, sus
segmentos aterrizan en el offset del run A. Verificado con ffprobe sobre
init+segmento concatenados:

```
ROTO  (init A + seg5 de B):  video start=0.022969s   audio start=0.000000s
```

Ningún flag de ffmpeg lo evita: `+dash`, `+cmaf`, `+negative_cts_offsets` y
`-avoid_negative_ts disabled` escriben el empty edit igual (medido en `bb67bc0`).

### Prueba de que el arreglo funciona

Quitando el `edts` del init y fijando `tfdt = start × timescale`:

```
FIJO  (init canónico + seg5 de B retimed):  video start=20.000000s  audio start=20.000000s
FIJO0 (init canónico + seg0 de A retimed):  video start= 0.000000s  audio start= 0.000000s
```

Clava el límite que declara la playlist y de paso **mejora el lipsync**: la
referencia sana de hoy tiene vídeo en 20,023 y audio en 20,039 (16 ms de
desfase), y el retimeado deja las dos pistas en 20,000 exactos.

### Datos de formato que condicionan el diseño

- `tfdt` y `sidx` son **versión 1** (64 bits) → parchearlos **no cambia el
  tamaño de la caja**, así que no hay que recalcular tamaños de padres. Las
  funciones leen y escriben también la versión 0 (32 bits) sin promocionarla,
  que es lo que preserva el tamaño; desbordarla exigiría ~13 h de película a
  timescale 90000, fuera del caso real.
- Cada pista tiene su **timescale propio** (medido: vídeo 12800, audio 44100),
  así que el retimeado es por pista, no global.
- Estructura del segmento: `styp, sidx, sidx, moof, mdat`, con **un solo
  `moof`** y la cabecera en los primeros ~2,5 KB.
- El handler `seek` del servidor (`hub.ts:99`) **no tiene puerta de host**: ya
  valida, recorta al rango, reinicia ffmpeg, difunde y escribe el mensaje de
  sistema. La restricción a host es solo del cliente (`Player.tsx:305`).

## Decisiones

- **Quitar el `edts` entero**, no intentar distinguir «empty edit intrínseco del
  códec» de «empty edit por el `-ss`». Medido: sin edit list las dos pistas caen
  en el mismo instante absoluto, que es mejor lipsync que conservarlo.
- **Desplazar el `tfdt`, no fijarlo**: `delta = objetivo − tfdt del primer moof`,
  aplicado a todos los `tfdt` y `sidx` de esa pista. Con un `moof` por segmento
  da lo mismo, pero mantiene el espaciado interno si algún día hay más.
- **Parchear solo la cabecera y seguir sirviendo el `mdat` en streaming**, en vez
  de leer el segmento entero a memoria: a 8 Mbps un segmento de 4 s son ~4 MB por
  petición y por espectador.
- **La sesión calcula el tiempo absoluto**, no `api.ts`: `TranscodeSession` ya
  tiene el plan de segmentos, así que sabe qué instante le toca a cada índice.
- **`-copyts` se queda como está.** Con el retimeado ya no influye en la
  corrección; quitarlo sería un cambio de comportamiento sin medida que lo
  respalde.

## Diseño

### Módulo nuevo `server/src/media/fmp4.ts` (puro, sin I/O)

Tres funciones sobre `Buffer`, testeables aisladas:

- **`canonicalizeInit(buf)` → `{ init, timescales }`**
  Reconstruye el árbol de cajas quitando el `edts` de cada `trak` y
  recalculando los tamaños de `trak`/`moov`. Pone a 0 las `duration` de
  `mvhd`/`tkhd`/`mdhd`, para que el init resultante sea **byte-idéntico venga
  del run que venga** (un run reiniciado codifica menos metraje y escribiría
  otra duración). Devuelve `trackID → mdhd.timescale`.
- **`retimeHeader(head, timescales, startSec)` → `Buffer`**
  Por pista: `delta = round(startSec × timescale) − tfdt del primer moof`,
  aplicado in situ a todos los `tfdt` y a `sidx.earliest_presentation_time`.
- **`headerLength(buf)` → `number`**
  Offset del `mdat`.

### `server/src/media/transcoder.ts`

- `requestInit` canonicaliza al hacer el snapshot: `init_V.stable.mp4` nace ya
  canónico, y de paso guarda los timescales de ese variante en un mapa de la
  sesión (`variante → (trackID → timescale)`), que es de donde los lee
  `openSegment`. Sigue devolviendo la ruta. La lógica actual de
  «esperar a que el init esté entero» (`segFreshEnough`, escritura por tmp +
  rename, guardas de sesión cerrada) **no se toca**.
- Nuevo **`openSegment(variant, index)` → `Promise<Readable>`**: reutiliza
  `requestSegment` para esperar al archivo, lee la cabecera (hasta `mdat`, tope
  64 KB, con fallback a leer el archivo entero si no aparece), la retimea con
  `this.segments[index].start` y devuelve la cabecera parcheada seguida de
  `createReadStream(path, { start: headerLength })`. Memoria constante.
  Antes de retimear hace `await this.requestInit(variant)` para garantizar que
  el mapa de timescales existe; tras la primera llamada es un `existsSync` y
  vuelve al momento.
- `requestSegment` sigue existiendo como primitiva de espera (y como está
  cubierta por tests, no cambia de contrato).

### `server/src/http/api.ts`

La ruta `seg_V_NNNNN.m4s` pasa de `requestSegment` + `createReadStream` a
`openSegment`. El resto de la ruta (validación de variante, 404, 504) igual.

### Web: barra arrastrable para todos

- `web/src/player/Player.tsx`: el `div.progress` de solo lectura pasa a
  `input[type=range]`. Mientras se arrastra **muestra** el valor local sin
  mandar nada (si no, el tick de 500 ms del reloj de sala pelea con el pulgar);
  solo al soltar emite `{ t: 'seek', position }`.
- Se quita el gate `isHost` del formulario «Ir a», que se queda para saltos
  precisos. `Player` deja de recibir el prop `isHost`; `Room.tsx` lo sigue
  usando para el botón de copiar enlace.
- `web/src/theme.css`: la barra reaprovecha el estilo de `.seek` que ya usa el
  slider de volumen.

### Tests

- **`server/test/fmp4.test.ts`** (unitario, bytes a mano): `canonicalizeInit`
  quita el `edts` y arregla los tamaños de los padres; `retimeHeader` desplaza
  todos los `tfdt` y `sidx` de cada pista por su propio timescale y no cambia la
  longitud del buffer; `headerLength` encuentra el `mdat`.
- **`server/test/fmp4.integration.test.ts`** (ffmpeg real, sobre la fixture MKV
  que ya existe): correr desde 0 y desde el segmento N; los dos inits
  canonicalizados salen **byte-idénticos**; el segmento N del run reiniciado,
  retimeado y concatenado con el init canónico, da `start_time` de vídeo y audio
  **exactamente** `segments[N].start` según ffprobe. Es la medición de este spec
  convertida en regresión.
- **`server/test/api.test.ts`**: la ruta de segmento devuelve bytes retimeados.
- **`web/`**: la barra emite `seek` al soltar y no en cada movimiento; el
  control aparece sin ser host.
- **`docs/e2e-checklist.md`**: «Ir a» deja de ser solo del host, y se añade el
  caso que hoy falla — saltar, dejar que ffmpeg reinicie, y saltar **otra vez** a
  una zona nueva.

## Fuera de alcance

- **Que ffmpeg caiga exacto en el límite pedido.** Fijar el `tfdt` al límite
  planificado hace la corrección independiente de dónde aterrice ffmpeg, que era
  la suposición frágil; pero si un reinicio se desvía, el contenido se desplaza
  esa desviación en vez de coincidir. Es un error acotado a decenas de ms
  (medido: 0 en la fuente de prueba), frente a los 20 s de hoy.
- Quitar `-copyts` o volver a evaluar `-output_ts_offset`.
- El `hardSeek` interno del controlador de deriva: es corrección de sync, no
  seek de usuario, y no se toca.
- Permisos por rol en la sala. Play/pausa ya es de todos y el seek pasa a serlo
  igual; no se introduce un modelo de moderación.
