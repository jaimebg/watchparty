import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AppDeps } from '../app.js'
import { saveConfig } from '../config.js'
import { variantCount } from '../media/hlsLayout.js'
import { buildMasterPlaylist, buildMediaPlaylist } from '../media/planner.js'
import { displayTitle } from '../media/tmdb.js'
import { pickFolderNative } from './folderPicker.js'
import { isPathInside, makeRequireAdmin } from './security.js'

const M3U8 = 'application/vnd.apple.mpegurl'
const RETRY_COOLDOWN_MS = 10_000

export function registerApi(app: FastifyInstance, deps: AppDeps): void {
  const requireAdmin = makeRequireAdmin(deps.adminToken)
  const lastRetryAt = new Map<string, number>()

  app.get('/api/library', { preHandler: requireAdmin }, async () => deps.library())
  app.post('/api/library/rescan', { preHandler: requireAdmin }, async () => deps.library())

  const addFolder = (path: string | undefined, reply: FastifyReply) => {
    if (typeof path !== 'string' || !path.trim()) return reply.code(400).send({ error: 'ruta requerida' })
    let stat
    try { stat = statSync(path) } catch { return reply.code(400).send({ error: `la ruta no existe: ${path}` }) }
    if (!stat.isDirectory()) return reply.code(400).send({ error: `la ruta no es una carpeta: ${path}` })
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
    rooms: deps.rooms.all().map(r => ({ token: r.token, title: r.item.title })),
  }))

  app.post('/api/rooms', { preHandler: requireAdmin }, async (req, reply) => {
    const { itemId } = req.body as { itemId: string }
    const item = (await deps.library()).find(i => i.id === itemId)
    if (!item) return reply.code(404).send({ error: 'item not found' })
    if (!deps.config.mediaFolders.some(f => isPathInside(f, item.path))) return reply.code(400).send({ error: 'path outside media folders' })
    const room = await deps.rooms.create(item)
    return { token: room.token }
  })

  app.delete('/api/rooms/:token', { preHandler: requireAdmin }, async (req) => {
    await deps.rooms.close((req.params as any).token)
    return { ok: true }
  })

  app.get('/api/rooms/:token', async (req, reply) => {
    const room = deps.rooms.get((req.params as any).token)
    if (!room) return reply.code(404).send({ error: 'room not found' })
    return {
      title: displayTitle(room.meta, room.item.title), durationSec: room.info.durationSec,
      audio: room.info.audio, subtitles: room.subtitles, error: room.error,
      meta: room.meta,
    }
  })

  app.post('/api/rooms/:token/retry', async (req, reply) => {
    const room = deps.rooms.get((req.params as any).token)
    if (!room) return reply.code(404).send()
    const now = Date.now()
    const last = lastRetryAt.get(room.token)
    if (last !== undefined && now - last < RETRY_COOLDOWN_MS) return reply.code(429).send({ error: 'retry cooldown' })
    lastRetryAt.set(room.token, now)
    await deps.rooms.retry(room.token)
    return { ok: true }
  })

  app.get('/stream/:token/:file', async (req, reply) => {
    const { token, file } = req.params as { token: string; file: string }
    const room = deps.rooms.get(token)
    if (!room) return reply.code(404).send()
    if (file === 'master.m3u8') return reply.type(M3U8).send(buildMasterPlaylist(room.info.audio))
    if (file === 'video.m3u8') return reply.type(M3U8).send(buildMediaPlaylist(room.segments, 0))
    // Variant numbering follows ffmpegArgs's -var_stream_map: variant 0 is
    // video (con el audio dentro si solo hay una pista) y, cuando hay varias,
    // las variantes 1..audioCount son una por pista (audio_1..audio_N en la
    // playlist maestra). Anything outside that range is a bogus/attacker
    // request and must 404 without ever touching the transcode session — y con
    // un solo variant eso incluye audio_1, que ffmpeg no escribe: dejarlo pasar
    // colgaría la petición 30 s esperando un archivo que nunca llega.
    const variants = variantCount(room.info.audio.length)
    const audio = file.match(/^audio_(\d+)\.m3u8$/)
    if (audio) {
      const n = Number(audio[1])
      if (n < 1 || n >= variants) return reply.code(404).send()
      return reply.type(M3U8).send(buildMediaPlaylist(room.segments, n))
    }
    const init = file.match(/^init_(\d+)\.mp4$/)
    if (init) {
      const variant = Number(init[1])
      if (variant < 0 || variant >= variants) return reply.code(404).send()
      try {
        const p = await room.session.requestInit(variant)
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
      if (index < 0 || index >= room.segments.length) return reply.code(404).send()
      try {
        return reply.type('video/mp4').send(await room.session.openSegment(variant, index))
      } catch { return reply.code(504).send() }
    }
    const sub = file.match(/^sub_(\d+)\.vtt$/)
    if (sub) {
      const p = join(room.roomDir, file)
      if (!isPathInside(room.roomDir, p) || !existsSync(p)) return reply.code(404).send()
      return reply.type('text/vtt').send(createReadStream(p))
    }
    return reply.code(404).send()
  })
}
