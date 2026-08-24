import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AppDeps } from '../app.js'
import { saveConfig } from '../config.js'
import { variantCount } from '../media/hlsLayout.js'
import { buildMasterPlaylist, buildMediaPlaylist } from '../media/planner.js'
import { displayTitle } from '../media/tmdb.js'
import { RoomBusyError } from '../rooms/roomManager.js'
import { pickFolderNative } from './folderPicker.js'
import { isPathInside, makeRequireAdmin } from './security.js'

const M3U8 = 'application/vnd.apple.mpegurl'
const RETRY_COOLDOWN_MS = 10_000
// El epoch va en el path y no en una query porque el plano de datos puede salir
// por un relevo ajeno (ver streamBaseUrl en config.ts): así el versionado no
// depende de que ese proxy reenvíe la query ni de cómo calcule su clave de
// caché. Y de paso planner.ts no necesita saber que el epoch existe: sus URIs
// son relativas y el navegador las resuelve dentro de e<n>/.
// Sin ceros a la izquierda: `Number('007') === 7`, así que e7, e007 y e0000007
// servirían los mismos bytes bajo infinitas URLs distintas, y cada una es una
// clave de caché propia en el relevo de vídeo. Quien tenga el enlace de la sala
// podría llenarle el disco al VPS con copias del mismo segmento.
const EPOCH_RE = /^e([1-9]\d*)$/

export function registerApi(app: FastifyInstance, deps: AppDeps): void {
  const requireAdmin = makeRequireAdmin(deps.adminToken)
  const lastRetryAt = new Map<string, number>()

  app.get('/api/library', { preHandler: requireAdmin }, async () => deps.library())
  app.post('/api/library/rescan', { preHandler: requireAdmin }, async () => deps.library())

  const addFolder = (path: string | undefined, reply: FastifyReply) => {
    if (typeof path !== 'string' || !path.trim()) return reply.code(400).send({ error: 'path required' })
    let stat
    try { stat = statSync(path) } catch { return reply.code(400).send({ error: `path not found: ${path}` }) }
    if (!stat.isDirectory()) return reply.code(400).send({ error: `not a folder: ${path}` })
    if (!deps.config.mediaFolders.includes(path)) {
      deps.config.mediaFolders.push(path)
      saveConfig(deps.config)
    }
    return deps.library()
  }

  app.get('/api/config/folders', { preHandler: requireAdmin }, async () => ({ folders: deps.config.mediaFolders }))

  app.post('/api/config/folders', { preHandler: requireAdmin }, async (req, reply) => {
    const { path } = (req.body ?? {}) as { path?: string }
    return addFolder(path, reply)
  })

  // Idempotente: quitar una carpeta que ya no está sigue devolviendo la biblioteca.
  // Las salas activas no se tocan (su sesión ya tiene el archivo abierto).
  app.delete('/api/config/folders', { preHandler: requireAdmin }, async (req) => {
    const { path } = (req.body ?? {}) as { path?: string }
    deps.config.mediaFolders = deps.config.mediaFolders.filter(f => f !== path)
    saveConfig(deps.config)
    return deps.library()
  })

  app.post('/api/config/pick-folder', { preHandler: requireAdmin }, async (_req, reply) => {
    const picked = await (deps.pickFolder ?? pickFolderNative)()
    if (!picked) return { cancelled: true }
    return addFolder(picked, reply)
  })

  app.get('/api/status', { preHandler: requireAdmin }, async () => ({
    tunnelUrl: deps.tunnel.url,
    rooms: deps.rooms.all().map(r => ({ token: r.token, title: r.media?.item.title ?? 'No movie' })),
  }))

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
        // El identificador del ítem de biblioteca, para que el selector sepa
        // cuál está en emisión sin comparar títulos: `title` de aquí abajo pasa
        // por displayTitle (año, nombre de TMDB, etiqueta de episodio) y deja de
        // parecerse al título del ítem en cuanto TMDB resuelve. Es un sha1 de la
        // ruta, así que no filtra dónde vive el fichero.
        itemId: media.item.id,
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

  // Con el plano de datos en otro origen (streamBaseUrl), hls.js pide las
  // playlists y los segmentos cross-origin y el <video> pide los VTT con
  // `crossorigin`: sin estas cabeceras el navegador se los traga en silencio y
  // la sala se queda en negro sin un error que mirar. `*` es la respuesta
  // correcta y no una relajación: esta ruta nunca lee cookies —el token de sala
  // ES el secreto, y va en el path— y `*` es precisamente lo que impide al
  // navegador enviar credenciales.
  const allowCors = (reply: FastifyReply) => reply.header('access-control-allow-origin', '*')

  // Los GET de hls.js son peticiones simples y no disparan preflight, así que
  // esto es red de seguridad: el día que algo pida un Range o una cabecera
  // propia, un preflight sin responder es otra pantalla en negro muda.
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
    // Sin película todavía no hay nada que servir bajo este token.
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
    if (file === 'video.m3u8') return reply.type(M3U8).send(buildMediaPlaylist(media.segments, 0))
    // Variant numbering follows ffmpegArgs's -var_stream_map: variant 0 is
    // video (con el audio dentro si solo hay una pista) y, cuando hay varias,
    // las variantes 1..audioCount son una por pista (audio_1..audio_N en la
    // playlist maestra). Anything outside that range is a bogus/attacker
    // request and must 404 without ever touching the transcode session — y con
    // un solo variant eso incluye audio_1, que ffmpeg no escribe: dejarlo pasar
    // colgaría la petición 30 s esperando un archivo que nunca llega.
    const variants = variantCount(media.info.audio.length)
    const audio = file.match(/^audio_(\d+)\.m3u8$/)
    if (audio) {
      const n = Number(audio[1])
      if (n < 1 || n >= variants) return reply.code(404).send()
      return reply.type(M3U8).send(buildMediaPlaylist(media.segments, n))
    }
    const init = file.match(/^init_(\d+)\.mp4$/)
    if (init) {
      const variant = Number(init[1])
      if (variant < 0 || variant >= variants) return reply.code(404).send()
      try {
        const p = await media.session.requestInit(variant)
        return reply.type('video/mp4').send(createReadStream(p))
      } catch { return reply.code(504).send() }
    }
    const seg = file.match(/^seg_(\d+)_(\d+)\.m4s$/)
    if (seg) {
      const variant = Number(seg[1])
      if (variant < 0 || variant >= variants) return reply.code(404).send()
      const index = Number(seg[2])
      // Un índice fuera del plan es una petición inventada, no un fallo del
      // servidor: con el proceso de ffmpeg ya terminado, requestSegment lo
      // resolvería mirando solo existsSync y acabaría sirviendo bytes sin
      // reanclar en silencio (el fallo que openSegment existe para matar). Se
      // rechaza aquí, sin tocar la sesión, igual que la variante de arriba.
      if (index < 0 || index >= media.segments.length) return reply.code(404).send()
      try {
        return reply.type('video/mp4').send(await media.session.openSegment(variant, index))
      } catch { return reply.code(504).send() }
    }
    const sub = file.match(/^sub_(\d+)\.vtt$/)
    if (sub) {
      const p = join(media.dir, file)
      if (!isPathInside(media.dir, p) || !existsSync(p)) return reply.code(404).send()
      return reply.type('text/vtt').send(createReadStream(p))
    }
    return reply.code(404).send()
  })
}
