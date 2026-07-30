# Destello de reacciones, emojis personalizables y pantalla completa con chat flotante

**Fecha:** 2026-07-30
**Estado:** Aprobado

## Objetivo

Tres mejoras independientes sobre la sala:

1. **Destello de reacción.** En la lista de participantes del chat, ver en
   pequeño qué emoji acaba de mandar cada persona.
2. **Accesos rápidos personalizables.** Poder poner *cualquier* emoji en la
   barra de reacciones, eligiéndolo en un modal propio con catálogo completo y
   buscador, y que la selección persista para ese espectador.
3. **Pantalla completa total** del vídeo, con el chat flotando abajo a la
   derecha.

## Contexto

- La barra de reacciones tiene hoy diez emojis fijos en una constante
  (`web/src/chat/ReactionsBar.tsx:3`).
- El servidor difunde `{ t: 'reaction', emoji, from }` con `from` = **nombre**
  del participante (`server/src/ws/hub.ts:127`). El cliente ignora ese campo:
  `chatStore` solo guarda `{ id, emoji }` (`web/src/chat/chatStore.ts:24`) y
  `ReactionOverlay` solo pinta el emoji.
- Las reacciones ya se retiran sin temporizadores: el `<span>` del overlay
  dispara `onAnimationEnd` → acción `drop-reaction`
  (`web/src/pages/Room.tsx:36-40`, `web/src/chat/ReactionOverlay.tsx:17`).
- Con `prefers-reduced-motion` el overlay conserva la duración de la animación
  pero cambia a `fade-hold`, precisamente porque la retirada depende de
  `animationend` (`web/src/theme.css:1100-1102`, `1110`).
- La lista de participantes son chips con puntito de color y nombre
  (`web/src/chat/ChatPanel.tsx:53-60`, `theme.css:921-951`).
- `.room-grid` es un grid de dos columnas que ya contiene `.video-stage`
  (vídeo + overlay + barra de reacciones) y `.chat-panel`
  (`web/src/pages/Room.tsx:230-237`, `theme.css:746-759`).
- Los controles del player son una barra estática **debajo** del vídeo
  (`web/src/player/Player.tsx:345`), y el vídeo está topado a
  `max-height: calc(100vh - 190px)` (`theme.css:761-764`).
- No existe hoy ningún botón, hook ni CSS de pantalla completa.
- El espacio ya es play/pausa global, con la guarda `spaceBelongsTo`
  (`web/src/player/format.ts:47`).
- Persistencia por espectador: ya se usa `localStorage` con claves `jbg-name`,
  `jbg-volume`, `jbg-muted`.

## Decisiones

- **Identificación de la reacción por `fromId`, no por nombre.** Dos invitados
  pueden entrar con el mismo nombre y el destello caería en el chip
  equivocado. `Participant.id` ya es único. Como el nombre no lo consume nadie
  en el cliente, se **sustituye** en vez de añadirse un campo más.
- **Destello temporal (~2,5 s)**, no «última reacción fija» ni pila de varias:
  la lista vuelve a estar limpia sola y el chip no cambia de tamaño.
- **Caducidad por `animationend`**, sin `setTimeout`, replicando el patrón que
  ya usa el overlay.
- **Catálogo completo (1.906 emojis) commiteado como JSON**, generado a mano
  desde emojibase-data en español. Ni dependencia de runtime, ni paso de build
  con red, ni set curado que obligue a tocar código cuando falte un emoji.
- **Sin selector de tono de piel.** No se ha pedido y multiplicaría el
  catálogo.
- **Sin reordenar la barra.** Los emojis se añaden al final; para cambiar el
  orden se quita y se vuelve a añadir. Descartado tanto el arrastre (no
  funciona en táctil sin maquinaria propia, y media sala entra desde el móvil)
  como las flechas ◀ ▶.
- **Toda la gestión vive dentro del modal.** La barra solo gana un botón `+`,
  así que durante la película no hay ningún control destructivo al alcance de
  un clic accidental.
- **Pantalla completa = solo CSS sobre `.room-grid`.** Es el único enfoque que
  no mueve nada en el árbol de React, así que el `ChatPanel` no se desmonta al
  entrar y salir: no se pierde el texto a medio escribir, ni el scroll, ni el
  buscador de GIFs abierto. Descartado mover el chat dentro de `.video-stage`
  (remonta) y descartado un `FloatingChat` aparte (duplicaría el render de
  mensajes y la lógica del input).
- **`requestFullscreen()` con respaldo «modo cine».** El iPhone no permite
  poner en pantalla completa un contenedor HTML —solo el `<video>` desnudo, sin
  overlays— así que ahí el mismo botón fija `.room-grid` a `position: fixed;
  inset: 0`. Una sola clase CSS gobierna los dos modos.
- **El chrome se auto-oculta; el `ReactionOverlay` no.** Los emojis volando son
  justo lo que se quiere ver con la sala a oscuras.

## Diseño

### 1. Destello de reacción

#### Protocolo (`server/src/ws/messages.ts` + copia manual `web/src/types.ts`)

- `{ t: 'reaction'; emoji: string; from: string }` pasa a
  `{ t: 'reaction'; emoji: string; fromId: string }`.

#### Servidor (`server/src/ws/hub.ts`)

- El `case 'reaction'` difunde `fromId: me.id` en lugar de `from: me.name`.
  Sin más cambios: la validación de `msg.emoji` y el recorte a 8 caracteres se
  quedan como están.

#### Estado (`web/src/chat/chatStore.ts`)

- `ChatState` gana `flashes: Record<string, { id: number; emoji: string }>`,
  indexado por id de participante.
- `case 'reaction'`: además de empujar al overlay, escribe
  `flashes[m.fromId] = { id, emoji }` **reusando el mismo `++reactionId`**, de
  modo que overlay y destello comparten identificador.
- `case 'welcome'`: resetea `flashes` a `{}`, por el mismo motivo por el que ya
  resetea `buffering` — una pestaña en segundo plano no ejecuta animaciones, y
  un destello podría sobrevivir a la reconexión.
- `case 'presence'`: poda `flashes` a las claves que sigan en el roster. Quien
  reacciona y se marcha acto seguido deja su chip fuera del DOM, así que su
  `animationend` no llega nunca y su entrada se quedaría hasta el siguiente
  `welcome`.
- Nueva función pura `dropFlash(state, pid, id)`: borra la entrada **solo si el
  id coincide**. Si esa persona ha vuelto a reaccionar mientras tanto, el
  `animationend` del destello viejo no debe llevarse por delante al nuevo.

#### Acción de UI (`web/src/pages/Room.tsx`)

- `RoomChatAction` gana `{ t: 'drop-flash'; pid: string; id: number }`, junto a
  `drop-reaction`. `chatReducer` sigue aceptando solo `ServerMsg`.

#### UI (`web/src/chat/ChatPanel.tsx` + `web/src/theme.css`)

- Dentro del `<li>` de cada participante, tras el nombre:
  `<span key={flash.id} className="reaction-flash" onAnimationEnd={…}>`.
  La `key` es el id del destello, no el del participante: así una reacción
  nueva **remonta** el `<span>` y la animación arranca de cero en vez de
  quedarse a medias.
- `.reaction-flash`: `font-size: 0.85rem`, `line-height: 1`, animación
  `flash-pop` de 2,5 s `forwards` (misma duración que el overlay).
- `@keyframes flash-pop`: aparece con un pequeño rebote de escala, se sostiene
  y se desvanece.
- En el bloque `@media (prefers-reduced-motion: reduce)`, `.reaction-flash`
  recibe `animation-name: fade-hold` junto a `.reaction-overlay span`.

### 2. Accesos rápidos personalizables

#### Catálogo (`web/src/chat/emojiCatalog.json`)

- Formato compacto `[[unicode, etiqueta, tags, grupo], …]` para ahorrar bytes:
  ~105 KB crudos, ~33 KB gzip.
- 1.906 entradas: todo emojibase-data en español **menos el grupo 2**, que son
  modificadores de tono de piel y de pelo, no emotes.
- Etiquetas y tags ya vienen en castellano (`🍿` → «palomitas», tag «maíz»).
- Se carga con `import()` dinámico la primera vez que se abre el modal, para
  que entrar a la sala no pague el peso del catálogo. Vite lo separa en su
  propio chunk automáticamente.

#### Generador (`web/scripts/gen-emoji-catalog.mjs`)

- Script suelto que descarga `emojibase-data@16/es/compact.json` de jsDelivr
  (versión fijada, no `latest`), filtra el grupo 2, recorta a los cuatro campos
  y escribe el JSON.
- Se ejecuta **a mano** cuando Unicode saque emojis nuevos. No entra en
  `build` ni en `test`: nadie necesita red para compilar ni para pasar tests.
- Documentado en el README junto al resto de tareas de mantenimiento.

#### Lógica pura

- `web/src/chat/emojiSearch.ts`
  - `normalize(s)`: minúsculas + `NFD` sin diacríticos, para que «corazon»
    encuentre «corazón».
  - `searchEmojis(catalog, query, limit)`: busca en etiqueta y tags, tope de
    120 resultados para no meter cientos de botones en el DOM.
- `web/src/chat/quickEmojis.ts`
  - `DEFAULT_QUICK`: los diez actuales
    (`😂 ❤️ 😱 🤯 🍿 🔥 👏 😭 💀 🙈`).
  - `MAX_QUICK = 12`. El tope existe porque en pantalla completa la barra es
    una fila única dentro de un panel estrecho.
  - `parseQuick(raw: string | null): string[]`: tolera JSON corrupto, valor que
    no es array y entradas que no son string cayendo a `DEFAULT_QUICK`;
    deduplica y recorta a `MAX_QUICK`.
  - `addQuick(list, emoji)`: no-op si ya está o si se alcanzó el tope; añade
    **al final**.
  - `removeQuick(list, emoji)`.
  - `loadQuick()` / `saveQuick(list)` sobre `localStorage['jbg-quick-emojis']`.
    Persistencia por navegador: no hay cuentas y las salas son efímeras.

#### Componentes

- `web/src/chat/ReactionsBar.tsx`: pasa a ser el dueño del estado de la lista
  (`useState(loadQuick)`, persistiendo en cada cambio) porque es su único
  consumidor y no hace falta prop drilling. Renderiza los emojis guardados más
  un botón `+` que abre el modal.
- `web/src/chat/EmojiPicker.tsx`: modal nuevo con, de arriba abajo,
  «Tus accesos rápidos» (chips con `×`, y aviso «Máximo 12: quita alguno para
  añadir más» con la rejilla deshabilitada al llegar al tope), separador,
  buscador, nueve pestañas de categoría, y la rejilla **solo de la categoría
  activa** — nunca 1.900 botones a la vez. Con búsqueda activa, la rejilla
  muestra los resultados en lugar de la categoría.
- Cierre: clic en el fondo y botón `✕`, igual que `MetaModal`. **Sin Escape**:
  en pantalla completa el navegador se queda esa tecla para salir del modo y no
  se puede evitar, así que sería un atajo que funciona a medias.

### 3. Pantalla completa con chat flotante

#### Hook (`web/src/player/useFullscreen.ts`)

- Expone `active: boolean`, `toggle()` y si hay soporte nativo.
- `requestFullscreen()` sobre el nodo de `.room-grid` donde exista; donde no
  (iPhone), activa el «modo cine»: la misma clase CSS más `position: fixed;
  inset: 0` y scroll del `body` bloqueado.
- Si `requestFullscreen()` **rechaza** la promesa (permiso denegado, gesto no
  confiable), cae al modo cine en vez de dejar un botón muerto.
- Escucha `fullscreenchange` y `webkitfullscreenchange`: salir con Escape o con
  el botón nativo del navegador debe sincronizar el estado, o la clase se
  quedaría puesta.
- En modo cine, un `keydown` de Escape sale a mano (la nativa ya lo hace sola).
- Al desmontar, suelta el fullscreen y el bloqueo de scroll. Importante:
  `Room` desmonta el player entero cuando ffmpeg falla.

#### Disparadores (`web/src/player/Player.tsx`, `web/src/player/format.ts`)

- Botón nuevo `btn-fullscreen` en `.controls`, con icono de entrar/salir.
- Doble clic sobre el `<video>`.
- Tecla `F`, guardada por un predicado **nuevo** `isTypingTarget(tagName,
  inputType, isContentEditable)` — input de texto, `TEXTAREA`, `SELECT`,
  contenteditable. No se puede reutilizar `spaceBelongsTo`: esa devuelve `true`
  para `BUTTON` (el espacio pulsa el botón enfocado), pero `F` sí debe
  funcionar con un botón enfocado. `spaceBelongsTo` se queda como está.

#### Maquetación (`web/src/theme.css`, clase `room-grid--fs`)

- `.room-grid--fs`: `display: block; position: relative`, fondo negro, a
  pantalla completa.
- `.video-stage`: `position: absolute; inset: 0`. El `<video>` a `height: 100%`
  con `object-fit: contain`; hay que **neutralizar** el
  `max-height: calc(100vh - 190px)` de `theme.css:761`.
- `.controls`: de barra estática a superpuestos abajo sobre un degradado.
- `.chat-panel`: flotante abajo a la derecha, `width: min(340px, 38vw)`,
  `max-height: min(60vh, 420px)`, fondo translúcido con `backdrop-filter` y
  borde ámbar tenue.
- `.reactions-bar`: **una sola fila**, `flex-wrap: nowrap` con
  `overflow-x: auto`. No es cosmético: al no envolver, su altura es fija y
  conocida, y los tres pisos (controles → reacciones → panel) se apilan desde
  abajo con `calc()` sobre variables CSS (`--fs-controls-h`, `--fs-emos-h`) en
  lugar de con desplazamientos a ojo que se rompen al llegar a doce emojis.
- En el DOM, panel y barra siguen siendo hermanos dentro de `.room-grid`; se
  leen como una pieza única compartiendo fondo y encajando las esquinas.

#### Auto-ocultado del chrome

- Estado `chromeVisible`, activo **solo** en pantalla completa; fuera de ella
  todo se ve siempre.
- Se oculta 3 s después del último evento que lo mostró; cada evento nuevo
  reinicia esa cuenta. Reaparece con:
  - movimiento del puntero o cualquier tecla dentro del contenedor;
  - foco dentro del chat (mientras se escribe no se oculta nunca);
  - **entrada nueva en el chat** — el requisito explícito: reaparece sin tocar
    el ratón. Se detecta comparando el id de la última entrada contra un `ref`,
    ignorando la primera ejecución para que el historial del `welcome` no
    dispare nada. Los mensajes de sistema («X pausó») **no** cuentan: solo
    `kind` de texto o GIF;
  - sala en pausa: si está parada, es que alguien está haciendo algo.
- Oculto = `opacity: 0` + `pointer-events: none` sobre controles, panel y barra
  de reacciones, más `cursor: none` en el contenedor.
- El `ReactionOverlay` queda **fuera** de la regla: nunca se oculta.

#### Consecuencias aceptadas

- La cabecera de la sala (`.room-head`, copiar enlace, Info) y el `MetaModal`
  están fuera de `.room-grid`, así que el navegador no los pinta en pantalla
  completa. Es lo correcto: son controles de antes de la función.
- Los pickers de GIF y de emojis **sí** están dentro de `.room-grid`, así que
  siguen funcionando en pantalla completa.
- El `<video>` mantiene `playsInline`, de modo que en iOS no se apodera de la
  pantalla por su cuenta.

## Tests

El proyecto prueba funciones puras con Vitest, no componentes; se sigue esa
línea.

- `web/test/chatStore.test.ts`: el destello se fija por participante; uno nuevo
  reemplaza al viejo del mismo participante; `dropFlash` con un id caducado no
  borra el destello nuevo; `welcome` limpia `flashes`; `presence` poda el
  destello de quien ya no está en el roster y conserva el de quien sí.
- `web/test/quickEmojis.test.ts` (nuevo): defaults; JSON corrupto; valor que no
  es array; entradas que no son string; duplicados; tope de 12; añadir y
  quitar.
- `web/test/emojiSearch.test.ts` (nuevo): búsqueda sin acentos, por tag, y tope
  de resultados.
- `web/test/format.test.ts`: `isTypingTarget` para cada tipo de elemento, y que
  `spaceBelongsTo` sigue devolviendo `true` para `BUTTON`.
- `server/test/hub.test.ts`: la reacción viaja con `fromId` (actualiza la
  aserción de `hub.test.ts:84`).

Pantalla completa y auto-ocultado son comportamiento de navegador: van al
`docs/e2e-checklist.md` con casos para entrar/salir por botón, doble clic, `F`
y Escape; el chat flotante visible sobre el vídeo; la reaparición al llegar un
mensaje sin tocar el ratón; el respaldo modo cine en iPhone; y que al volver de
pantalla completa el texto a medio escribir en el chat sigue ahí.

## Fuera de alcance

- Reordenar los accesos rápidos.
- Selector de tono de piel en el catálogo.
- Sincronizar los accesos rápidos entre dispositivos o entre salas (no hay
  cuentas; es `localStorage` por navegador).
- Reacciones con nombre en el overlay del vídeo (el overlay sigue pintando solo
  el emoji).
- Cambiar la maquetación fuera de pantalla completa.
- Historial o contador de reacciones por participante.
