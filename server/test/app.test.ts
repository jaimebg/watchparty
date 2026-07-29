import { describe, it, expect } from 'vitest'
import { buildApp } from '../src/app.js'
import { RoomManager } from '../src/rooms/roomManager.js'

describe('app', () => {
  it('responds to /health', async () => {
    const app = await buildApp({
      config: { mediaFolders: [], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 },
      library: async () => [],
      rooms: new RoomManager({ createSession: () => { throw new Error('not used') } }),
      adminToken: 't',
    })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })
})
