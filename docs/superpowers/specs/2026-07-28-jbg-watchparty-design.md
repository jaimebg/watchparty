# jbg-watchparty — Diseño

**Fecha:** 2026-07-28
**Estado:** aprobado en brainstorming, pendiente de plan de implementación

## Objetivo

Servidor local multiplataforma (Windows y macOS) para ver películas/series en grupo (3–6 personas) de forma sincronizada. El host ejecuta el servidor en su máquina; los invitados entran por navegador desde internet mediante un túnel integrado. Incluye chat en tiempo real con reacciones y GIFs. Cada espectador elige su pista de audio y de subtítulos de forma independiente; la posición de reproducción se sincroniza entre todos.

## Requisitos acordados

- **Host:** ejecuta el servidor en Windows o macOS desde el repo (`npm install && npm start`).
- **Invitados:** solo navegador (Chrome/Safari/Firefox), cero instalación. Acceden por URL pública HTTPS de un túnel cloudflared Quick Tunnel que la app lanza automáticamente.
- **Aforo:** grupos pequeños (3–6 personas).
- **Control:** cualquier participante puede pausar, reanudar y saltar; todos se sincronizan.
- **Pistas:** audio y subtítulos son elección individual de cada espectador; solo la posición temporal es compartida.
- **Formatos de entrada:** MKV multipista, MP4/H.264, AVI, HEVC/x265, etc. Subtítulos incrustados de texto y `.srt` externos junto al vídeo.
- **Chat:** texto, reacciones emoji flotantes sobre el vídeo, buscador de GIFs con la API de Klipy (la API de Tenor ya no existe).
- **Biblioteca:** carpetas de medios configuradas; la app lista los vídeos y el host elige cuál reproducir.

## Arquitectura

Monorepo con dos paquetes:

- **`server/`** — Node ≥ 20 + TypeScript con Fastify.
  - API REST: biblioteca, creación/gestión de salas, arranque de sesiones de transcodificación.
  - Servido de segmentos HLS y playlists.
  - Servido del cliente web compilado como estáticos.
  - WebSocket: sincronización de reproducción + chat + reacciones + presencia.
  - Procesos externos orquestados:
    - **ffmpeg/ffprobe** vía paquete `ffmpeg-static` (binarios incluidos para Windows y macOS; nada que instalar).
    - **cloudflared**: descarga del binario de la plataforma en el primer arranque, cacheado en el directorio de datos.
- **`web/`** — React + Vite, reproductor con **hls.js**. Mismo cliente para host (via `localhost`) e invitados (via URL del túnel).

Flujo de arranque: `npm start` → escaneo de carpetas de medios → arranque del túnel → se abre el navegador en la biblioteca → el host elige vídeo → se crea la sala → se comparte el enlace → los invitados entran con su nombre.

## Pipeline de vídeo

Al seleccionar un vídeo, `ffprobe` inventaría las pistas. Un único proceso ffmpeg por sala genera HLS (segmentos fMP4 de 4 s) en una carpeta de caché:

- **Vídeo:** H.264 de origen → `-c:v copy` (sin transcodificación). Otros códecs (HEVC, MPEG-4 ASP…) → transcodificación a H.264. Aceleración hardware autodetectada: VideoToolbox (macOS), NVENC/QSV (Windows), fallback libx264.
- **Audio:** cada pista de audio del origen → una rendition AAC estéreo separada en la master playlist, etiquetada con idioma (metadata del contenedor o "Pista N"). hls.js cambia de rendition al vuelo: la elección de idioma es por espectador y no genera trabajo extra en el servidor.
- **Subtítulos:** pistas de texto incrustadas (SRT, ASS/SSA) y archivos `.srt` adyacentes → conversión a WebVTT, expuestos como pistas de texto seleccionables por espectador. Subtítulos de imagen (PGS, VobSub): fuera de la v1, se listan en la UI como «no soportado».
- **Seek:** la duración total se conoce, así que la playlist declara todos los segmentos desde el inicio. Si un cliente pide un segmento aún no generado, el servidor detiene ffmpeg y lo relanza con `-ss` alineado al segmento pedido. Los segmentos ya generados persisten en caché (retroceder no cuesta nada). Una única sesión de transcodificación activa por sala.
- **Caché:** en el directorio de datos; se vacía al cerrar la sala y al arrancar el servidor; límite configurable (por defecto 10 GB).

## Salas y sincronización

El servidor es la autoridad única del estado: `{ vídeoActual, pausado, posiciónBase, timestampServidor }`.

- Acciones (pausar/reanudar/seek) → WebSocket → el servidor actualiza el estado y lo difunde a todos.
- Cada cliente calcula la posición objetivo (`posiciónBase + transcurrido si no está pausado`) y corrige deriva:
  - < 0,3 s → ignorar.
  - 0,3–2 s → ajuste suave con `playbackRate` 0,95×/1,05× hasta realinear.
  - > 2 s → seek directo.
- Rebuffering de un participante: se notifica y la sala muestra «X está cargando…». No se pausa automáticamente al resto en v1.
- Un participante que entra a mitad de sesión recibe el estado actual y engancha.
- Reconexión WebSocket con backoff exponencial; al reconectar se recupera estado y chat.

## Chat, reacciones y GIFs

Mismo WebSocket, mensajes tipados:

- **Texto:** nombre + color de participante (asignados al entrar).
- **GIFs:** buscador integrado contra la API de Klipy. El servidor hace proxy de las búsquedas; la API key vive en la config del servidor y nunca llega al cliente. Resultado elegido → mensaje-GIF embebido en el chat. Sin API key configurada, el botón de GIFs se oculta y el resto del chat funciona igual.
- **Reacciones:** barra de emojis rápidos (😂 ❤️ 😱 🔥 👏 😭); al pulsar, el emoji flota subiendo sobre el vídeo en todas las pantallas (estilo Instagram Live). No aparecen en el historial del chat.
- **Sistema:** «Ana pausó el vídeo», «Luis saltó a 1:12:30», «Marta se unió/salió».
- Historial en memoria del servidor; se pierde al cerrar la sala. Sin persistencia en v1.

## Biblioteca y configuración

- `config.json` en el directorio de datos de la app (`~/Library/Application Support/jbg-watchparty` en macOS, `%APPDATA%\jbg-watchparty` en Windows): carpetas de medios, API key de Klipy, puerto, nombre del host, límite de caché.
- Primer arranque sin carpetas configuradas → asistente en la web para añadir la primera carpeta.
- Escaneo: extensiones `.mkv .mp4 .avi .m4v .webm`, agrupación por carpeta (una serie = su carpeta, episodios ordenados por nombre de archivo), detección de `.srt` adyacentes.
- Presentación: nombre de archivo limpiado con regex (fuera `1080p`, `x265-GRUPO`, puntos por espacios…) + duración de ffprobe. Sin metadatos externos (TMDB) en v1.
- Escaneo al arrancar y botón «Reescanear».

## Seguridad y acceso

- URL de sala con token aleatorio de alta entropía (`/room/<token>`); sin el enlace exacto no se entra.
- HTTPS de serie vía cloudflared.
- Rol de host: cookie de admin emitida al navegador que entra por `localhost` al arrancar. Solo el host crea salas, cambia el vídeo y cierra la sala. Los invitados ven la sala, no la biblioteca.
- Invitados: solo nombre para el chat; sin cuentas.
- El servidor valida toda ruta solicitada contra las carpetas de medios configuradas (protección path traversal).

## Manejo de errores

- **ffmpeg falla:** la sala muestra el error con las últimas líneas de log y botón «Reintentar». Si falló el modo copy, el reintento fuerza transcodificación.
- **Túnel caído:** el servidor lo detecta y relanza; banner en la sala. Los Quick Tunnels cambian de URL en cada arranque: si el túnel se reinicia, hay que recompartir el enlace (limitación asumida en v1).
- **Desconexión de invitado:** aviso en chat, reconexión automática, re-enganche al estado actual.
- **Disco:** limpieza de caché al cerrar sala y al arrancar; límite configurable.

## Testing

- **Unit (vitest):** cálculo de deriva y corrección de sync, matemática de segmentos/playlists HLS, limpieza de nombres de archivo, validación de rutas.
- **Integración:** pipeline ffmpeg contra clips sintéticos generados en el propio test (MKV de 30 s multi-audio + subtítulos creado con ffmpeg): verifica renditions de audio, WebVTT y seek con reinicio de proceso.
- **E2E manual:** checklist documentado en el repo (dos navegadores, uno vía túnel real; cambiar audio en uno y verificar que el otro no cambia; verificar sync tras seek; reconexión).

## Ejecución y distribución

- v1: `npm install && npm start` desde el repo. Node ≥ 20. ffmpeg y cloudflared se resuelven automáticamente.
- Multiplataforma vía APIs de Node (rutas, directorios de datos).
- Empaquetado como binario/instalable (Electron, pkg…): explícitamente fuera de la v1; el diseño no lo impide a futuro.

## Fuera de alcance en v1

- Subtítulos de imagen (PGS/VobSub) — ni burn-in ni conversión OCR.
- Persistencia de chat e historial de salas.
- Metadatos externos (TMDB, carátulas).
- Pausa automática global cuando alguien rebufferea.
- Cuentas de usuario y permisos más allá de host/invitado.
- Empaquetado nativo/instalador.
- URL de túnel estable entre reinicios (requeriría cuenta de Cloudflare con dominio propio).
