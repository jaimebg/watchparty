import { randomBytes } from 'node:crypto'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { scanLibrary } from './library/scanner.js'
import { RoomManager } from './rooms/roomManager.js'
import { TranscodeSession } from './media/transcoder.js'
import { detectEncoder } from './media/hwaccel.js'

const config = loadConfig()
const adminToken = randomBytes(16).toString('base64url')
const encoder = await detectEncoder()

// Wiring is provisional — full config-driven setup lands in Task 15.
const rooms = new RoomManager({
  createSession: (item, info, segments, roomDir, forceTranscode = false) => {
    const mode = !forceTranscode && info.videoCodec === 'h264' ? 'copy' : 'transcode'
    return new TranscodeSession({
      input: item.path, mode, encoder, segments, audioCount: info.audio.length, outDir: roomDir,
    })
  },
})

const app = await buildApp({
  config,
  library: () => scanLibrary(config.mediaFolders),
  rooms,
  adminToken,
})
await app.listen({ port: config.port, host: '0.0.0.0' })
console.log(`jbg-watchparty en http://localhost:${config.port}`)
console.log(`admin token: ${adminToken}`)
