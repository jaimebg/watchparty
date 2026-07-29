import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { buildApp } from '../src/app.js'
import { RoomManager } from '../src/rooms/roomManager.js'

describe('/api/status', () => {
  it('reports tunnel url and rooms, admin only', async () => {
    process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'st-'))
    const app = await buildApp({
      config: { mediaFolders: [], klipyApiKey: null, port: 8400, hostName: 'H', cacheLimitGB: 10 },
      library: async () => [],
      rooms: new RoomManager({ createSession: () => ({ start() {}, seekTo() {}, async stop() {}, onError() {}, lastLog: [], requestSegment: async () => '', openSegment: async () => Readable.from([]), requestInit: async () => '' }) }),
      adminToken: 'adm', tunnel: { url: 'https://x.trycloudflare.com' },
    })
    expect((await app.inject({ url: '/api/status' })).statusCode).toBe(401)
    const res = await app.inject({ url: '/api/status', cookies: { admin: 'adm' } })
    expect(res.json()).toEqual({ tunnelUrl: 'https://x.trycloudflare.com', rooms: [] })
    await app.close()
  })
})
