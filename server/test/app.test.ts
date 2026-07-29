import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { RoomManager } from '../src/rooms/roomManager.js'

const baseDeps = () => ({
  config: { mediaFolders: [], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 },
  library: async () => [],
  rooms: new RoomManager({ createSession: () => { throw new Error('not used') } }),
  adminToken: 't', tunnel: { url: null },
})

describe('app', () => {
  it('responds to /health', async () => {
    const app = await buildApp(baseDeps())
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })
})

describe('static web/dist serving', () => {
  const webDir = fileURLToPath(new URL('../../web', import.meta.url))
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
  let webDirPreexisted = false

  beforeEach(() => { webDirPreexisted = existsSync(webDir) })

  afterEach(() => {
    // Only remove what this test fabricated (web/dist), never the whole web/ tree —
    // once Task 16 creates the real web workspace (package.json, src/, …) under web/,
    // a blanket `rm -rf web` here would silently destroy it on every test run.
    rmSync(webDist, { recursive: true, force: true })
    if (!webDirPreexisted && existsSync(webDir) && readdirSync(webDir).length === 0) {
      rmSync(webDir, { recursive: true, force: true })
    }
  })

  it('serves files and falls back to index.html for non-API routes when web/dist exists', async () => {
    mkdirSync(webDist, { recursive: true })
    writeFileSync(`${webDist}/index.html`, '<html>spa</html>')
    writeFileSync(`${webDist}/app.js`, 'console.log(1)')

    const app = await buildApp(baseDeps())

    const asset = await app.inject({ url: '/app.js' })
    expect(asset.statusCode).toBe(200)
    expect(asset.body).toBe('console.log(1)')

    const spa = await app.inject({ url: '/room/abc123' })
    expect(spa.statusCode).toBe(200)
    expect(spa.body).toBe('<html>spa</html>')

    const apiMiss = await app.inject({ url: '/api/does-not-exist' })
    expect(apiMiss.statusCode).toBe(404)
    expect(apiMiss.json()).toEqual({ error: 'not found' })

    await app.close()
  })
})
