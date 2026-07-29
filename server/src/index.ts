import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { buildApp } from './app.js'
import { cacheDir, loadConfig } from './config.js'
import { scanLibrary } from './library/scanner.js'
import { RoomManager } from './rooms/roomManager.js'
import { TranscodeSession } from './media/transcoder.js'
import { detectEncoder } from './media/hwaccel.js'
import { pickPrunable, segmentFilesWithStats } from './media/cachePrune.js'
import { Tunnel } from './tunnel/cloudflared.js'

const config = loadConfig()
rmSync(cacheDir(), { recursive: true, force: true })
mkdirSync(cacheDir(), { recursive: true })

const encoder = await detectEncoder()
const rooms = new RoomManager({
  createSession: (item, info, segments, roomDir, forceTranscode) => new TranscodeSession({
    input: item.path,
    // Copy-remux only when we know the browser can decode the source as-is:
    // h264 in 8-bit 4:2:0 (yuv420p). Anything else (e.g. Hi10P's yuv420p10le)
    // must be transcoded, or it renders as a black screen in most browsers.
    mode: !forceTranscode && info.videoCodec === 'h264' && info.pixFmt === 'yuv420p' ? 'copy' : 'transcode',
    encoder, segments, audioCount: info.audio.length, outDir: roomDir,
  }),
})

setInterval(() => {
  const limit = config.cacheLimitGB * 2 ** 30
  const files = rooms.all().flatMap(r => segmentFilesWithStats(r.roomDir))
  for (const p of pickPrunable(files, limit)) rmSync(p, { force: true })
}, 60_000).unref()

const adminToken = randomBytes(12).toString('base64url')
const tunnel = new Tunnel(config.port)
const app = await buildApp({ config, library: () => scanLibrary(config.mediaFolders), rooms, adminToken, tunnel })

await app.listen({ port: config.port, host: '0.0.0.0' })
tunnel.onUrl(u => console.log(`\n🌍 URL pública: ${u}\n`))
tunnel.onDown(() => console.log('⚠️  Túnel caído, reintentando…'))
tunnel.start()

const adminUrl = `http://localhost:${config.port}/?key=${adminToken}`
console.log(`🎬 jbg-watchparty — panel: ${adminUrl}`)
if (process.platform === 'darwin') spawn('open', [adminUrl])
else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', adminUrl])

process.on('SIGINT', async () => {
  for (const r of rooms.all()) await rooms.close(r.token)
  tunnel.stop()
  await app.close()
  process.exit(0)
})
