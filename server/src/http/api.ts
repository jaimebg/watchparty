import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../app.js'
import { buildMasterPlaylist, buildMediaPlaylist } from '../media/planner.js'
import { isPathInside, makeRequireAdmin } from './security.js'

const M3U8 = 'application/vnd.apple.mpegurl'

export function registerApi(app: FastifyInstance, deps: AppDeps): void {
  const requireAdmin = makeRequireAdmin(deps.adminToken)

  app.get('/api/library', { preHandler: requireAdmin }, async () => deps.library())
  app.post('/api/library/rescan', { preHandler: requireAdmin }, async () => deps.library())

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
      title: room.item.title, durationSec: room.info.durationSec,
      audio: room.info.audio, subtitles: room.subtitles, error: room.error,
    }
  })

  app.post('/api/rooms/:token/retry', async (req, reply) => {
    const room = deps.rooms.get((req.params as any).token)
    if (!room) return reply.code(404).send()
    await deps.rooms.retry(room.token)
    return { ok: true }
  })

  app.get('/stream/:token/:file', async (req, reply) => {
    const { token, file } = req.params as { token: string; file: string }
    const room = deps.rooms.get(token)
    if (!room) return reply.code(404).send()
    if (file === 'master.m3u8') return reply.type(M3U8).send(buildMasterPlaylist(room.info.audio))
    if (file === 'video.m3u8') return reply.type(M3U8).send(buildMediaPlaylist(room.segments, 0))
    const audio = file.match(/^audio_(\d+)\.m3u8$/)
    if (audio) return reply.type(M3U8).send(buildMediaPlaylist(room.segments, Number(audio[1])))
    const init = file.match(/^init_(\d+)\.mp4$/)
    if (init) {
      const p = join(room.roomDir, file)
      if (!isPathInside(room.roomDir, p) || !existsSync(p)) return reply.code(404).send()
      return reply.type('video/mp4').send(createReadStream(p))
    }
    const seg = file.match(/^seg_(\d+)_(\d+)\.m4s$/)
    if (seg) {
      try {
        const p = await room.session.requestSegment(Number(seg[1]), Number(seg[2]))
        return reply.type('video/mp4').send(createReadStream(p))
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
