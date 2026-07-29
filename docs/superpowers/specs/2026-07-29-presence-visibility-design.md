# Estado activo/ausente de participantes según visibilidad de pestaña

**Fecha:** 2026-07-29
**Estado:** Aprobado

## Objetivo

Mostrar en la lista de participantes del chat quién tiene la pestaña de la
sala visible («encendido») y quién la tiene en segundo plano o el navegador
minimizado («apagado»). El chip del participante ausente se ve atenuado.

## Contexto

- El roster vive en memoria en el servidor: `Participant { id, name, color }`
  (`server/src/ws/messages.ts:3`), un mapa socket → participante por sala
  (`server/src/ws/hub.ts:11`).
- Todo cambio de roster se difunde con un broadcast `presence` que lleva la
  lista completa (`hub.ts:82` en join, `hub.ts:143` en close); no hay deltas.
- La lista se pinta en `web/src/chat/ChatPanel.tsx:43-50` como chips con
  puntito de color + nombre.
- No existe hoy ningún manejo de visibilidad, focus ni heartbeat.

## Decisiones

- **Señal:** Page Visibility API (`visibilitychange` sobre `document`), no
  focus/blur de window. «Apagado» solo cuando la pestaña está oculta o el
  navegador minimizado; tener la sala visible sin focus sigue contando como
  «encendido». Es la señal estable típica de watch party.
- **UI:** atenuar el chip completo (opacidad reducida) cuando el participante
  está ausente. Sin segundo puntito de estado.
- **Modelo:** campo `active: boolean` dentro de `Participant`, viajando en los
  broadcasts `welcome`/`presence` existentes (opción elegida sobre un evento
  suelto estilo `buffering`, que dejaría al recién llegado sin el estado
  inicial de los demás y heredaría el keying por nombre).

## Diseño

### Protocolo (`server/src/ws/messages.ts` + copia manual `web/src/types.ts`)

- `Participant` gana `active: boolean`.
- Nuevo mensaje de cliente: `{ t: 'visibility', active: boolean }`.
- Sin mensajes nuevos de servidor: el estado viaja en `welcome` y `presence`.

### Servidor (`server/src/ws/hub.ts`)

- En `join`, el participante se crea con `active: true`.
- Nuevo `case 'visibility'`: valida `typeof msg.active === 'boolean'`,
  actualiza `me.active` y difunde `presence` con el roster completo.
- El participante sintético de mensajes de sistema (`system()`, `hub.ts:28`)
  gana `active: true` para cumplir el tipo.
- Sin mensajes de sistema en el chat por cambios de visibilidad (sería ruido).

### Cliente (`web/src/pages/Room.tsx`)

- Listener de `visibilitychange` en `document` mientras la sala está montada;
  envía `{ t: 'visibility', active: document.visibilityState === 'visible' }`.
- Al (re)conectar, tras enviar `join` se envía el estado actual de visibilidad
  por si la pestaña ya estaba oculta al conectar.
- Sin debounce: `visibilitychange` solo dispara al cambiar de pestaña o
  minimizar, no en cada alt-tab entre ventanas visibles.

### UI (`web/src/chat/ChatPanel.tsx` + `web/src/theme.css`)

- El `<li>` del participante recibe clase `away` cuando `!p.active`.
- `.participants li.away { opacity: 0.45 }` con transición suave de opacidad;
  `title="ausente"` en el chip.

### Tests

- `server/test/hub.test.ts`: un mensaje `visibility` actualiza `active` del
  participante y rebroadcastea `presence` con el roster completo; `active`
  llega `true` por defecto en el `welcome`.
- `web/test/chatStore.test.ts`: sin cambios (el reducer ya reemplaza
  `participants` tal cual llega).

## Fuera de alcance

- Estados intermedios («mirando pero sin focus») o heartbeat/detección de
  sockets muertos.
- Persistencia del estado entre reconexiones (cada conexión nueva ya crea un
  participante nuevo; entra como `active: true` y se corrige con el primer
  `visibilitychange` o el envío post-join).
- Cambios en el keying por nombre de `buffering`.
