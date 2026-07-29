# jbg-watchparty

Servidor local multiplataforma para ver películas y series en grupo de forma sincronizada. El host ejecuta el servidor en su máquina; los invitados entran por navegador desde internet mediante un túnel integrado. Incluye chat en tiempo real con reacciones y GIFs.

**Características:**
- 🎬 Sincronización de reproducción en tiempo real (pausa, play, seek)
- ⏳ La sala espera al espectador que se queda cargando (con tope de 20 s, para que una conexión mala no pare la sesión)
- 🎙️ Selección independiente de pista de audio y subtítulos por espectador
- 💬 Chat en vivo con reacciones flotantes y búsqueda de GIFs
- 🔗 Acceso remoto automático via túnel HTTPS seguro (cloudflared)
- 🖥️ Soporte multiplataforma (Windows y macOS)
- 🎯 Grupos pequeños (3–6 personas)

## Requisitos

- **Node.js** ≥ 20
- **npm** o equivalente
- Windows o macOS (archivos compilados de ffmpeg y cloudflared incluidos)

## Instalación

### Paso 1: Descargar e instalar dependencias

```bash
npm install
```

### Paso 2: Configurar carpetas de medios

La primera vez, la biblioteca te ofrece un botón **«📁 Elegir carpeta…»** que abre el
diálogo nativo de tu sistema (Finder/Explorador) para elegir la carpeta de tus vídeos —
no hace falta tocar ningún archivo. Si lo prefieres, también puedes escribir la ruta a
mano en el mismo asistente, o editar la configuración directamente.

La configuración se lee en dos capas, de menos a más prioridad:

1. **`config.defaults.json`** (en la raíz del repo, versionado). Lleva las API keys y el
   túnel, así que al clonar el repo en otra máquina ya funciona todo sin reconfigurar
   nada. Como contiene secretos, **el repo debe seguir siendo privado**.
2. **`config.json`** (local, fuera del repo). Solo lo propio de cada máquina —
   principalmente `mediaFolders`. Vive en el directorio de datos de tu plataforma:
   - **macOS:** `~/Library/Application Support/jbg-watchparty/config.json`
   - **Windows:** `%APPDATA%\jbg-watchparty\config.json`

Un valor del `config.json` local pisa al del repo, salvo si es `null`: `null` significa
«sin configurar» y deja pasar el valor compartido. Y al guardar desde la UI solo se
persiste localmente lo que difiere del repo, de modo que si rotas una key en
`config.defaults.json` todas las máquinas la recogen sin tocar nada.

Ejemplo completo (mismos campos en ambos archivos):

```json
{
  "mediaFolders": [
    "/Users/tuusuario/Videos/Películas",
    "/Users/tuusuario/Videos/Series"
  ],
  "klipyApiKey": "tu-api-key-aqui-opcional",
  "tmdbApiKey": "tu-api-key-de-tmdb-opcional",
  "port": 8400,
  "cacheLimitGB": 10
}
```

**Campos de configuración:**
- **`mediaFolders`** (array de strings): Rutas absolutas a carpetas que contengan vídeos (MKV, MP4, AVI, etc.). Obligatorio; también se puede añadir la primera carpeta desde el panel del host si arrancas con la biblioteca vacía. Es específico de cada máquina: va en el `config.json` local, no en `config.defaults.json`.
- **`klipyApiKey`** (string, opcional): API key de Klipy para buscar y enviar GIFs en el chat. Si no está presente, el botón de GIFs se oculta.
- **`tunnelToken`** (string, opcional): Token de un named tunnel de Cloudflare. Con él (junto a `tunnelUrl`), el servidor usa tu túnel con URL fija en vez del Quick Tunnel aleatorio. Ver [URL fija con tu dominio](#url-fija-con-tu-dominio-named-tunnel).
- **`tunnelUrl`** (string, opcional): URL pública fija del túnel, p. ej. `https://watchparty.tudominio.com`. Obligatorio si usas `tunnelToken` (deben configurarse juntos).
- **`tmdbApiKey`** (string, opcional): API key de TMDB (themoviedb.org → Ajustes → API). Con ella, al crear una sala se buscan metadatos por el nombre del archivo: el título de la sala pasa a ser «Título (año)» y aparece un botón **ℹ️ Info** con carátula, nota y sinopsis en español. Los episodios (`S01E02` en el nombre) se buscan como series. Sin key, todo funciona igual pero con el nombre del archivo pelado.
- **`port`** (número): Puerto HTTP del servidor (por defecto: 8400).
- **`cacheLimitGB`** (número): Límite de caché HLS en GB (por defecto: 10). Se limpia automáticamente al cerrar salas.

### Paso 3: Ejecutar el servidor

```bash
npm start
```

El servidor:
1. Escanea las carpetas de medios configuradas
2. Lanza automáticamente un túnel HTTPS seguro (cloudflared Quick Tunnel)
3. Abre tu navegador en `http://localhost:8400/?key=<token-admin>` — el `key` es un token generado al arrancar que autentica el panel del host (se guarda en una cookie tras la primera visita)
4. Muestra la URL pública segura para compartir con los invitados

### Paso 4: Compartir el enlace

Copia la URL pública que aparece en la consola o en la interfaz web. Los invitados entran así:
1. Hacen clic en el enlace HTTPS
2. Entran con su nombre
3. Ven la sala en vivo (sin crear una nueva)

## URL fija con tu dominio (named tunnel)

Por defecto el servidor usa un Quick Tunnel de cloudflared: la URL (`*.trycloudflare.com`)
cambia en cada arranque. Si tienes un dominio gestionado en Cloudflare, puedes tener una
URL fija (p. ej. `https://watchparty.tudominio.com`) con un setup único:

1. Entra en [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → **Networks → Tunnels → Create a tunnel** (tipo Cloudflared) y dale un nombre (p. ej. `watchparty`).
2. En el paso del conector, **no instales nada**: solo copia el token que aparece en el comando (`cloudflared service install <TOKEN>` — el token es la cadena larga).
3. En **Public Hostnames**, añade `watchparty.tudominio.com` → servicio `http://localhost:8400` (el puerto de tu `config.json`). Cloudflare crea la ruta DNS automáticamente.
4. En `config.json`, añade:

```json
{
  "tunnelToken": "eyJh...tu-token...",
  "tunnelUrl": "https://watchparty.tudominio.com"
}
```

Al arrancar, el servidor lanza tu túnel con esa URL fija (la misma en cada reinicio). Si
falta alguno de los dos campos, avisa por consola y vuelve al Quick Tunnel. La app usa su
propio binario de cloudflared; no hace falta instalarlo ni correr ningún servicio del sistema.

## Obtener API Key de Klipy (opcional)

Para usar búsqueda de GIFs en el chat:

1. Ve a [https://klipy.com/developers](https://klipy.com/developers)
2. Crea una cuenta e inicia sesión
3. Genera una nueva API key
4. Copia la key y pégala en el campo `klipyApiKey` de `config.json`

Sin API key, el chat funciona perfectamente; solo no está disponible el botón de GIFs.

## Formatos soportados

**Vídeos:**
- MKV (Matroska) — múltiples pistas de audio y subtítulos
- MP4 (H.264)
- AVI
- WebM

**Códecs de vídeo:**
- Todo se transcodifica a H.264 con keyframes forzados cada 4 s (aceleración por
  hardware cuando la hay: VideoToolbox en macOS, NVENC/QSV en Windows).

  Copiar el vídeo tal cual sería más barato, pero la playlist es VOD —el
  servidor tiene que declarar *de antemano* dónde va a cortar cada segmento— y
  en modo copia los cortes los elige el muxer HLS de ffmpeg contra una rejilla
  propia que el servidor no puede predecir. Cuando las dos listas no coinciden,
  la playlist se queda corta y la sala se congela a mitad de película.
  El razonamiento completo, con las medidas, está en
  `server/src/media/hlsLayout.ts`.

  Además, el servidor fija la línea de tiempo del medio en vez de heredarla de
  ffmpeg: sirve un init canónico (sin el *edit list* donde ffmpeg guarda en qué
  punto arrancó ese proceso) y ancla la cabecera de cada segmento al instante que
  la playlist ya declara. Sin eso, un salto de posición solo aterrizaba bien
  mientras la sala siguiera corriendo sobre el ffmpeg que produjo el primer init.
  La edición de cajas MP4 vive en `server/src/media/fmp4.ts`.

**Pistas de audio:**
- Con una sola pista, el audio viaja dentro del propio segmento de vídeo.
- Con varias, cada una se expone como rendition AAC seleccionable
  independientemente por cada espectador.

**Subtítulos:**
- Pistas de texto incrustadas (SRT, ASS/SSA)
- Archivos `.srt` externos junto al vídeo (se detectan automáticamente)
- Conversión a WebVTT para reproducción en navegador
- Pistas de imagen (PGS/VobSub) se omiten en silencio: no aparecen en el selector de subtítulos de la sala

## Características del chat

### Mensajes de texto
- Cada usuario tiene un color asignado al entrar
- Mensajes bidireccionales en tiempo real

### Reacciones
- Barra de emojis rápidos (😂 ❤️ 😱 🔥 👏 😭)
- Los emojis flotan subiendo sobre el vídeo en ambas pantallas (estilo Instagram Live)
- No aparecen en el historial del chat

### GIFs
- Búsqueda integrada contra la API de Klipy (si está configurada)
- El resultado elegido se embebe como mensaje en el chat
- Solo visible si la API key está en `config.json`

### Mensajes de sistema
- Notificaciones cuando alguien se une, sale, pausa, reanuda o cambia de vídeo

## Desarrollo

### Ejecutar en modo desarrollo

Abre dos terminales:

**Terminal 1 — Servidor (sin auto-reload):**
```bash
npm start -w server
```
`tsx` corre el servidor directamente desde TypeScript, pero sin `--watch`: tras cada cambio en `server/src`, para el proceso (`Ctrl+C`) y vuelve a lanzar `npm start -w server`.

**Terminal 2 — Cliente (con Vite dev server):**
```bash
npm run dev -w web
```

Accede a `http://localhost:5173/` para el cliente en desarrollo.

### Ejecutar tests

```bash
npm test
```

Corre unit tests y tests de integración para ambos paquetes (server y web).

### Verificación de tipos

```bash
npx tsc --noEmit
```

En server/: verifica tipos TypeScript del servidor.

```bash
cd web && npx tsc --noEmit
```

En web/: verifica tipos TypeScript del cliente.

### Build de producción

```bash
npm run build -w web
```

Compila el cliente React para producción en `web/dist/`.

## Limitaciones en v1

- **Subtítulos de imagen** (PGS/VobSub) — no soportados; se omiten en silencio (no aparecen como opción en el selector)
- **Persistencia** — el chat e historial de salas se pierden al cerrar la sala
- **Metadatos externos** — sin carátulas ni información de TMDB
- **Cuentas de usuario** — sin autenticación; solo roles host/invitado básicos
- **Empaquetado nativo** — v1 requiere Node.js y `npm start`; Electron/instalador quedan para futuras versiones

## Estructura del proyecto

```
.
├── server/                   # Fastify + Node.js
│   ├── src/
│   │   ├── index.ts          # Punto de entrada
│   │   ├── app.ts            # Construcción de la app Fastify (rutas + estáticos)
│   │   ├── config.ts         # Carga/guardado de config.json
│   │   ├── http/              # Rutas REST (biblioteca, salas, stream, klipy, admin)
│   │   ├── library/           # Escaneo de carpetas de medios
│   │   ├── media/             # Probe, planificación de segmentos, ffmpeg, cajas MP4, subtítulos, caché
│   │   ├── rooms/             # Estado de sala y sincronización de reproducción
│   │   ├── ws/                # WebSocket (sync, chat, reacciones, presencia)
│   │   └── tunnel/            # Integración cloudflared
│   └── package.json
├── web/                      # React + Vite + hls.js
│   ├── src/
│   │   ├── App.tsx           # Componente raíz (routing simple por pathname)
│   │   ├── api.ts, ws.ts, types.ts
│   │   ├── pages/             # Biblioteca, sala
│   │   ├── player/            # Reproductor HLS y sincronización de deriva
│   │   ├── chat/               # Chat, reacciones, GIFs
│   │   └── sync/               # Cálculo de corrección de deriva
│   └── package.json
├── package.json              # Root workspace
└── README.md                 # Este archivo
```

## Troubleshooting

### El servidor no arranca
- Verifica que Node.js ≥ 20 esté instalado: `node --version`
- Comprueba que `config.json` existe y tiene al menos un `mediaFolder` válido
- Revisa que no hay otro proceso en el puerto configurado (por defecto 8400)

### Los invitados no pueden conectar
- La URL pública requiere conexión a internet; usa datos móviles para verificar desde otro dispositivo
- Si el túnel cae, el servidor lo relanza automáticamente; con Quick Tunnel la URL cambia y hay que recompartir el enlace (con named tunnel la URL fija se mantiene)
- Comprueba que el navegador está actualizado (Chrome, Safari, Firefox recientes)

### El vídeo no reproduce
- Verifica que el archivo está en una carpeta configurada en `mediaFolders`
- Si es HEVC/x265, ffmpeg está transcodificando; puede tomar varios minutos en hardware antiguo
- Si hay error, la sala muestra el log de ffmpeg con un botón «Reintentar»
- Si tras un salto la posición se queda quieta y aparece «X está cargando…», es el comportamiento esperado: la sala espera al rezagado hasta 20 s
- Antes, saltar a mitad de un MKV siempre dejaba solo los subtítulos sobre una imagen en negro; era un bug de sincronización ya corregido. Si lo vuelves a ver, repórtalo — no es una limitación conocida

### El audio no cambia en algunos espectadores
- Es comportamiento esperado: cada usuario elige su pista de forma independiente
- Solo la posición de reproducción se sincroniza globalmente

## Licencia

Privado — ver `LICENSE` para detalles.
