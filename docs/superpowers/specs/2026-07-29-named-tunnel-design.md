# URL fija de túnel vía Cloudflare Named Tunnel

**Fecha:** 2026-07-29
**Estado:** Aprobado

## Objetivo

Sustituir la URL aleatoria `*.trycloudflare.com` (Quick Tunnel, cambia en cada
arranque) por la URL fija `https://example.com`, usando un named
tunnel de Cloudflare autenticado por token. El Quick Tunnel se mantiene como
fallback cuando no hay token configurado.

## Contexto

- `example.com` ya está gestionado en Cloudflare (nameservers rodney/sonia).
- El túnel «watchparty» ya existe en el dashboard Zero Trust; la ruta DNS
  `example.com` ya resuelve a Cloudflare. El ingress
  (`example.com → http://localhost:8400`) vive en Cloudflare
  (túnel gestionado remotamente), así que la app solo necesita el token.
- La app ya descarga su propio binario de cloudflared (`ensureBinary`); no se
  usa servicio del sistema ni instalación por brew.

## Diseño

### Config (`server/src/config.ts`)

Dos campos nuevos opcionales en `config.json`, con default `null`:

- `tunnelToken` — token del named tunnel (el de `cloudflared service install <token>`).
- `tunnelUrl` — URL pública fija, p. ej. `https://example.com`.

Regla: el modo named tunnel se activa solo si **ambos** están presentes. Si
solo hay uno, se loguea un warning claro y se cae al Quick Tunnel.

### Túnel (`server/src/tunnel/cloudflared.ts`)

`Tunnel` pasa de `new Tunnel(port)` a `new Tunnel({ port, token?, publicUrl? })`.

- **Modo named** (token + publicUrl): spawn
  `cloudflared tunnel run --token <token>`. El named tunnel no imprime URL;
  se detecta en stderr la línea `Registered tunnel connection` para saber que
  está conectado, y entonces `url = publicUrl` y se dispara `onUrl` (una sola
  vez por proceso). Se exporta `parseNamedReady(line)` como función pura
  testeable, análoga a `parseTunnelUrl`.
- **Modo quick** (sin token): flujo actual sin cambios.
- Reinicio con backoff exponencial y `onDown`: compartidos entre ambos modos
  (lógica existente en `exit`/`catch`).

### Integración

- `index.ts`: construye `Tunnel` con los campos de config.
- `app.ts` / `api.ts`: sin cambios (siguen leyendo `tunnel.url`).

### Manejo de errores

- Token inválido/revocado → cloudflared sale; aplica el backoff existente y
  `onDown` avisa por consola.
- Token sin `tunnelUrl` (o viceversa) → warning y fallback a Quick Tunnel.

### Tests (`server/test/cloudflared.test.ts`)

- `parseNamedReady` reconoce la línea `Registered tunnel connection` y devuelve
  false/null para otras líneas.
- Construcción de argumentos: con token → `tunnel run --token …`; sin token →
  `tunnel --url http://localhost:<port>` (se exporta `tunnelArgs` como función
  pura).

### Docs (`README.md`)

- Documentar `tunnelToken` y `tunnelUrl` en la sección de config.
- Paso a paso del setup único en el dashboard de Cloudflare.
- Quitar «URL de túnel estable» de las limitaciones v1.

## Fuera de alcance

- Redirección `example.com/watchparty` en nginx (el usuario eligió solo el
  subdominio).
- Gestión del túnel/ingress por API de Cloudflare desde la app.
- Instalación de cloudflared como servicio del sistema.
