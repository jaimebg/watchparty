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
// The epoch goes in the path rather than a query string because the data plane
// may leave through someone else's relay (see streamBaseUrl in config.ts): that
// way versioning does not depend on the proxy forwarding the query, nor on how it
// computes its cache key. As a bonus, planner.ts never needs to know the epoch
// exists: its URIs are relative and the browser resolves them inside e<n>/.
// No leading zeros: `Number('007') === 7`, so e7, e007 and e0000007 would serve
// the same bytes under endlessly many distinct URLs, each its own cache key on
// the video relay. Anyone holding the room link could fill the VPS disk with
// copies of the same segment.
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

  // Idempotent: removing a folder that is already gone still returns the library.
  // Active rooms are left alone (their session already has the file open).
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

  // Resolves the item and checks it sits inside the media folders. Sends the
  // error response and returns null; the caller does `return reply`.
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
    // No itemId means an empty room: the host hands out the link and picks
    // later, with people already inside chatting.
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
      // The previous movie's retry cooldown must not apply to the new one:
      // these are different ffmpeg runs.
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
    // '' means same origin (see streamBaseUrl in config.ts). It sits at the top
    // level rather than inside `media` because it describes where the server
    // lives, not the movie: the client needs it just as much in an empty room. It
    // rides along in this response, which the client already awaits before
    // mounting the player, so there is never a window where the <video> exists
    // without knowing its origin.
    const streamBase = deps.config.streamBaseUrl ?? ''
    if (!media) return { media: null, error: null, streamBase }
    return {
      media: {
        epoch: media.epoch,
        // The library item's id, so the picker can tell which one is playing
        // without comparing titles: `title` below goes through displayTitle
        // (year, TMDB name, episode label) and stops resembling the item's title
        // the moment TMDB resolves. It is a sha1 of the path, so it does not leak
        // where the file lives.
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
    // With no movie there is no ffmpeg run to retry.
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

  // With the data plane on another origin (streamBaseUrl), hls.js fetches the
  // playlists and segments cross-origin and the <video> fetches the VTTs with
  // `crossorigin`: without these headers the browser swallows them silently and
  // the room goes black with no error to look at. `*` is the correct answer here
  // and not a relaxation: this route never reads cookies (the room token IS the
  // secret, and it travels in the path) and `*` is precisely what stops the
  // browser from sending credentials.
  const allowCors = (reply: FastifyReply) => reply.header('access-control-allow-origin', '*')

  // hls.js's GETs are simple requests and do not trigger a preflight, so this is
  // a safety net: the day something asks for a Range or a custom header, an
  // unanswered preflight is one more silent black screen.
  app.options('/stream/:token/:epoch/:file', async (_req, reply) => allowCors(reply)
    .header('access-control-allow-methods', 'GET, HEAD, OPTIONS')
    .header('access-control-allow-headers', 'range')
    .header('access-control-max-age', '86400')
    .code(204).send())

  app.get('/stream/:token/:epoch/:file', async (req, reply) => {
    const { token, epoch, file } = req.params as { token: string; epoch: string; file: string }
    // Before anything else, the 404 included: a cross-origin error without CORS
    // headers gets swallowed by the browser with no trace to look at.
    allowCors(reply)
    const room = deps.rooms.get(token)
    if (!room) return reply.code(404).send()
    const media = room.media
    // With no movie yet, there is nothing to serve under this token.
    if (!media) return reply.code(404).send()
    const parsed = epoch.match(EPOCH_RE)
    // Malformed: it was never one of our URLs.
    if (!parsed) return reply.code(404).send()
    // An earlier generation: it existed and no longer does. 410 rather than 404
    // because during the switch the old hls.js instance keeps asking for these
    // URLs, and without this cutoff requestInit would leave them hanging for 30 s
    // waiting on a file in a directory that is already deleted.
    if (Number(parsed[1]) !== media.epoch) return reply.code(410).send()

    if (file === 'master.m3u8') return reply.type(M3U8).send(buildMasterPlaylist(media.info.audio))
    if (file === 'video.m3u8') return reply.type(M3U8).send(buildMediaPlaylist(media.segments, 0))
    // Variant numbering follows ffmpegArgs's -var_stream_map: variant 0 is video
    // (with the audio inside it when there is only one track) and, when there are
    // several, variants 1..audioCount are one per track (audio_1..audio_N in the
    // master playlist). Anything outside that range is a bogus/attacker request
    // and must 404 without ever touching the transcode session — and with a
    // single variant that includes audio_1, which ffmpeg does not write: letting
    // it through would hang the request for 30 s on a file that never arrives.
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
      // An index outside the plan is a made-up request, not a server failure:
      // with the ffmpeg process already finished, requestSegment would resolve it
      // on existsSync alone and end up serving bytes without re-anchoring, in
      // silence (the very bug openSegment exists to kill). It is rejected here,
      // without touching the session, just like the variant above.
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
