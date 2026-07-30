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
- **`streamBaseUrl`** (string, opcional): Origen desde el que los clientes piden el vídeo, p. ej. `https://stream.tudominio.com`. Sin él (por defecto), el vídeo sale por el mismo sitio que la app. Ver [Sacar el vídeo del CDN](#sacar-el-vídeo-del-cdn-plano-de-datos-aparte).
- **`relayPeerPublicKey`**, **`relayEndpoint`**, **`relayPeerIp`**, **`relayLocalIp`** (strings, opcionales): Datos del VPS del relevo, para que `npm run setup` pueda montar el túnel en una máquina nueva sin que nadie recuerde nada. Van en `config.defaults.json` porque describen el VPS y no la máquina, y ninguno es secreto (una clave pública y un endpoint). `relayLocalIp` es fija a propósito: el `reverse_proxy` del VPS apunta a una sola dirección, así que solo sirve un host a la vez.
- **`tmdbApiKey`** (string, opcional): API key de TMDB (themoviedb.org → Ajustes → API). Con ella, al crear una sala se buscan metadatos por el nombre del archivo: el título de la sala pasa a ser «Título (año)» y aparece un botón **ℹ️ Info** con carátula, nota y sinopsis en español. Los episodios (`S01E02` en el nombre) se buscan como series. Sin key, todo funciona igual pero con el nombre del archivo pelado.
- **`port`** (número): Puerto HTTP del servidor (por defecto: 8400).
- **`cacheLimitGB`** (número): Límite de caché HLS en GB (por defecto: 10). Se limpia automáticamente al cerrar salas.

### Paso 3: Ejecutar el servidor

```bash
npm start
```

`npm start` empieza por una **comprobación del entorno** que corre en macOS y en Windows:
arregla solo lo que puede arreglarse solo (levantar el túnel del relevo si está
configurado) y avisa del resto con la acción concreta al lado. Solo aborta si arrancar no
tendría sentido: Node por debajo de 20, sin ffmpeg, o el puerto ya ocupado por otra
instancia. Los avisos (biblioteca vacía, carpeta que ya no existe, túnel caído) no frenan
nada, porque el panel y la red local siguen funcionando.

```
🎬 jbg-watchparty — comprobación del entorno

✅ Node 22
✅ ffmpeg y ffprobe empaquetados
✅ Interfaz web compilada
✅ 1 carpeta(s) de medios
✅ Puerto 8400 libre
✅ Relevo activo hacia https://stream.example.com

▶️  Todo listo.
```

Puedes lanzarla suelta con `npm run preflight`. Después, el servidor:
1. Escanea las carpetas de medios configuradas
2. Lanza automáticamente un túnel HTTPS seguro (cloudflared Quick Tunnel)
3. Abre tu navegador en `http://localhost:8400/?key=<token-admin>` — el `key` es un token generado al arrancar que autentica el panel del host (se guarda en una cookie tras la primera visita)
4. Muestra la URL pública segura para compartir con los invitados

**Todos los comandos:**

| Comando | Para qué |
|---|---|
| `npm start` | Comprueba el entorno, compila la web y arranca el servidor |
| `npm run setup` | Puesta a punto de una máquina nueva (genera el túnel del relevo) |
| `npm run preflight` | Solo la comprobación del entorno, sin arrancar nada |
| `npm run tunnel:up` / `tunnel:down` | Control manual del túnel del relevo |
| `npm test` | Toda la batería de tests |

### Paso 4: Compartir el enlace

Copia la URL pública que aparece en la consola o en la interfaz web. Los invitados entran así:
1. Hacen clic en el enlace HTTPS
2. Entran con su nombre
3. Ven la sala en vivo (sin crear una nueva)

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

## Sacar el vídeo del CDN (plano de datos aparte)

Los términos del CDN de Cloudflare para planes Free/Pro/Business se reservan el derecho de
limitar el servicio a quien lo use «to serve video or a disproportionate percentage of
pictures, audio files, or other large files», con exención solo si el contenido está alojado
en un servicio de Cloudflare (Stream, Images, R2). El hostname público de un túnel es un
CNAME a `<uuid>.cfargotunnel.com`, que **solo resuelve a través del proxy** — no se puede
dejar en gris —, así que todo el vídeo pasa por el CDN por construcción. Una sesión de 6
personas y 2 horas son unos 30 GB.

`streamBaseUrl` separa los dos planos:

| Plano | Qué lleva | Por dónde sale |
|---|---|---|
| Control | HTML, API, WebSocket (chat, sync, presencia) | Túnel de Cloudflare — uso previsto, tráfico despreciable |
| Datos | `master.m3u8`, `init_*.mp4`, `seg_*.m4s`, `sub_*.vtt` | Tu relevo, sin pasar por el CDN |

Basta con apuntar el `master.m3u8` al relevo: HLS resuelve los nombres relativos de la
playlist contra la URL de esta, así que init y segmentos van detrás solos.

### Montar el relevo en un VPS (ejemplo con Oracle Cloud)

Oracle es buen encaje: 10 TB/mes de salida en Always Free, y su política de uso aceptable no
tiene cláusula de tipo de contenido equivalente a la del CDN de Cloudflare.

1. **Instancia y red.** Crea la VM y abre el 443 en la *Security List* del VCN (ingress
   0.0.0.0/0 → TCP 443). **Ojo con el paso que todo el mundo se salta:** las imágenes de
   Oracle traen `iptables` restrictivo persistido, así que abrir el VCN no basta:
   ```bash
   sudo iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save     # Ubuntu; en Oracle Linux: firewall-cmd --add-port=443/tcp --permanent
   ```
2. **DNS.** Registro `A` de `stream.tudominio.com` a la IP pública del VPS, **en gris
   (DNS-only)**. Es lo que mantiene el tráfico fuera del CDN; el DNS autoritativo gratuito no
   tiene restricción de contenido porque no transporta bytes.
3. **Túnel casa → VPS.** WireGuard entre las dos máquinas (el VPS como *endpoint* fijo). El
   host de casa no necesita ni IP pública ni port forwarding, y funciona detrás de CGNAT.
4. **TLS y proxy en el VPS.** Con Caddy, el `Caddyfile` entero es:
   ```
   stream.tudominio.com {
       reverse_proxy 10.0.0.2:8400   # la IP WireGuard del host de casa
   }
   ```
   Caddy saca y renueva el certificado de Let's Encrypt solo.
5. **Config del host.** En `config.json`:
   ```json
   { "streamBaseUrl": "https://stream.tudominio.com" }
   ```

**Reclamación por inactividad:** Oracle puede reclamar instancias Always Free que durante 7
días queden por debajo del percentil 95 del 20% de CPU **y** 20% de red (y 20% de memoria en
shapes A1). Un relevo que se usa dos horas a la semana entra de lleno en ese perfil. Opciones:
pasar la instancia a pago (céntimos al mes), mantenerla ocupada, o dar por hecho que tocará
recrearla y dejar los pasos de arriba en un script. No afecta a instancias de pago.

Sin `streamBaseUrl` todo sigue exactamente igual que antes (mismo origen), que es lo correcto
en LAN.

### Montar el extremo de casa en otra máquina (macOS o Windows)

Con los campos `relay*` ya en `config.defaults.json`, una máquina nueva se pone a punto con
un comando. Instala WireGuard primero — `brew install wireguard-tools` en macOS,
[el instalador oficial](https://www.wireguard.com/install/) en Windows — y luego:

```bash
npm run setup
```

Genera el par de claves de esa máquina, escribe su `wg0.conf` donde toque según la
plataforma, y te imprime el único comando que queda por lanzar en el VPS, con la clave
pública ya sustituida. Es idempotente: si el túnel ya está configurado no regenera nada,
porque hacerlo invalidaría la clave que el VPS tiene autorizada.

A partir de ahí, `npm start` levanta el túnel solo. Detalles de cómo lo hace:

- **Solo pide elevación si el túnel no está ya arriba** (contraseña de administrador en
  macOS, UAC en Windows). Arrancar el servidor dos veces la misma tarde no vuelve a
  preguntar.
- **No lo baja al terminar.** Un túnel inactivo cuesta un paquete cada 25 s, y bajarlo
  obligaría a una segunda autenticación por sesión. Para bajarlo: `npm run tunnel:down`.
- **Comprueba que el otro extremo responde**, no solo que la interfaz existe: un VPS caído
  deja una interfaz levantada que parece sana pero no sirve vídeo.

La elevación se pide por el diálogo del sistema y **no** por una regla `NOPASSWD` en
sudoers a propósito: en macOS el prefijo de Homebrew es escribible por el usuario, así que
dar sudo sin contraseña a un binario que ese mismo usuario puede reemplazar sería una
escalada a root para cualquier proceso que corra como él.

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
  ffmpeg: sirve un init canónico (sin las entradas del *edit list* que dependen
  del proceso concreto que arrancó ffmpeg; el resto, como el trim del retardo del
  códec, se conserva) y ancla la cabecera de cada segmento al instante que la
  playlist ya declara. Sin eso, un salto de posición solo aterrizaba bien
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
- Barra de emojis rápidos, personalizable por espectador
- El botón «+» abre un selector con el catálogo completo en español y buscador
- La selección se guarda en el navegador (hasta 12 emojis)
- Los emojis flotan subiendo sobre el vídeo en ambas pantallas (estilo Instagram Live)
- El emoji aparece además, pequeño y durante unos segundos, junto al nombre de
  quien lo mandó en la lista de participantes
- No aparecen en el historial del chat

### GIFs
- Búsqueda integrada contra la API de Klipy (si está configurada)
- El resultado elegido se embebe como mensaje en el chat
- Solo visible si la API key está en `config.json`

### Mensajes de sistema
- Notificaciones cuando alguien se une, sale, pausa, reanuda o cambia de vídeo

## Pantalla completa
- Botón en los controles, doble clic sobre el vídeo o tecla `F`
- El chat y las reacciones flotan abajo a la derecha sobre el vídeo
- Todo se oculta tras unos segundos sin actividad y vuelve al mover el ratón,
  pulsar una tecla o llegar un mensaje nuevo; con el chat enfocado o la sala
  en pausa, no llega a ocultarse
- En iPhone, donde el navegador no permite pantalla completa con overlays, se
  usa un «modo cine» que ocupa la ventana

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

### Regenerar el catálogo de emojis

```bash
node web/scripts/gen-emoji-catalog.mjs
```

Reescribe `web/src/chat/emojiCatalog.ts` desde emojibase-data en español.
Solo hace falta cuando Unicode saca emojis nuevos. Necesita red, y por eso
queda fuera del build y de los tests.

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
