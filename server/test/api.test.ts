import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { RoomManager } from '../src/rooms/roomManager.js'
import { makeFixtureMkv } from './support/fixture.js'
import { scanLibrary } from '../src/library/scanner.js'

let app: Awaited<ReturnType<typeof buildApp>>, mediaDir: string, token: string
const ADMIN = 'test-admin-token'

const fakeSession = {
  start: () => {}, seekTo: () => {}, stop: async () => {}, onError: () => {}, lastLog: [] as string[],
  requestSegment: async (v: number, i: number) => {
    const p = join(process.env.JBG_DATA_DIR!, 'fake.m4s'); writeFileSync(p, 'seg'); return p
  },
}

beforeAll(async () => {
  process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'api-'))
  mediaDir = mkdtempSync(join(tmpdir(), 'apimedia-'))
  await makeFixtureMkv(mediaDir)
  app = await buildApp({
    config: { mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 },
    library: () => scanLibrary([mediaDir]),
    rooms: new RoomManager({ createSession: () => fakeSession }),
    adminToken: ADMIN,
  })
})
afterAll(async () => { await app.close() })

const admin = { cookies: { admin: ADMIN } }

describe('api', () => {
  it('library requires admin', async () => {
    expect((await app.inject({ url: '/api/library' })).statusCode).toBe(401)
    const res = await app.inject({ url: '/api/library', ...admin })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
  })

  it('creates a room and exposes public room info', async () => {
    const items = (await app.inject({ url: '/api/library', ...admin })).json()
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: { itemId: items[0].id }, ...admin })
    expect(res.statusCode).toBe(200)
    token = res.json().token
    expect(token.length).toBeGreaterThan(15)
    const info = (await app.inject({ url: `/api/rooms/${token}` })).json()
    expect(info.audio).toHaveLength(2)
    expect(info.subtitles.length).toBeGreaterThanOrEqual(1)
  })

  it('serves master and media playlists', async () => {
    const m = await app.inject({ url: `/stream/${token}/master.m3u8` })
    expect(m.statusCode).toBe(200)
    expect(m.body).toContain('audio_1.m3u8')
    const v = await app.inject({ url: `/stream/${token}/video.m3u8` })
    expect(v.body).toContain('#EXT-X-ENDLIST')
  })

  it('serves segments via session and rejects weird paths', async () => {
    const s = await app.inject({ url: `/stream/${token}/seg_0_00000.m4s` })
    expect(s.statusCode).toBe(200)
    expect((await app.inject({ url: `/stream/${token}/../../etc/passwd` })).statusCode).toBe(404)
    expect((await app.inject({ url: `/stream/${token}/evil.txt` })).statusCode).toBe(404)
    expect((await app.inject({ url: `/stream/NOEXISTE/master.m3u8` })).statusCode).toBe(404)
  })

  it('404s (without leaking the filesystem path) for roomDir files missing on disk', async () => {
    // sub id that was never extracted to disk (extractSubtitle failed silently, or id simply doesn't exist)
    const missingSub = await app.inject({ url: `/stream/${token}/sub_999.vtt` })
    expect(missingSub.statusCode).toBe(404)
    expect(missingSub.body).not.toContain(process.env.JBG_DATA_DIR!)

    // init file: the fake session never writes one, so this always misses on disk
    const missingInit = await app.inject({ url: `/stream/${token}/init_0.mp4` })
    expect(missingInit.statusCode).toBe(404)
    expect(missingInit.body).not.toContain(process.env.JBG_DATA_DIR!)
  })
})
