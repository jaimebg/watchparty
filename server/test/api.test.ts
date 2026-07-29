import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { RoomManager } from '../src/rooms/roomManager.js'
import { makeFixtureMkv } from './support/fixture.js'
import { scanLibrary } from '../src/library/scanner.js'

let app: Awaited<ReturnType<typeof buildApp>>, mediaDir: string, token: string, rooms: RoomManager
const ADMIN = 'test-admin-token'

const fakeSession = {
  start: () => {}, seekTo: () => {}, stop: async () => {}, onError: () => {}, lastLog: [] as string[],
  requestSegment: vi.fn(async (_v: number, _i: number) => {
    const p = join(process.env.JBG_DATA_DIR!, 'fake.m4s'); writeFileSync(p, 'seg'); return p
  }),
}

beforeAll(async () => {
  process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'api-'))
  mediaDir = mkdtempSync(join(tmpdir(), 'apimedia-'))
  await makeFixtureMkv(mediaDir)
  rooms = new RoomManager({ createSession: () => fakeSession })
  app = await buildApp({
    config: { mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 },
    library: () => scanLibrary([mediaDir]),
    rooms,
    adminToken: ADMIN, tunnel: { url: null },
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

  it('adds a media folder (persisted + rescanned library) when the path is a real directory', async () => {
    const cfg = { mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 }
    const folderApp = await buildApp({
      config: cfg, library: () => scanLibrary(cfg.mediaFolders), rooms, adminToken: ADMIN, tunnel: { url: null },
    })
    const newDir = mkdtempSync(join(tmpdir(), 'apimedia2-'))
    await makeFixtureMkv(newDir)

    const res = await folderApp.inject({ method: 'POST', url: '/api/config/folders', payload: { path: newDir }, ...admin })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2) // original item + the new folder's item
    expect(cfg.mediaFolders).toContain(newDir)
    expect(loadConfig().mediaFolders).toContain(newDir) // persisted via saveConfig

    // adding the same folder again must not duplicate it
    const again = await folderApp.inject({ method: 'POST', url: '/api/config/folders', payload: { path: newDir }, ...admin })
    expect(again.statusCode).toBe(200)
    expect(cfg.mediaFolders.filter(f => f === newDir)).toHaveLength(1)

    await folderApp.close()
  })

  it('rejects a non-existent path with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/config/folders', payload: { path: '/no/existe/de/verdad/xyz' }, ...admin })
    expect(res.statusCode).toBe(400)
  })

  it('requires admin to add a media folder', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/config/folders', payload: { path: mediaDir } })
    expect(res.statusCode).toBe(401)
  })

  it('admits admin via ?key= (setting a hardened cookie) and rejects a wrong cookie value', async () => {
    const viaKey = await app.inject({ url: `/api/library?key=${ADMIN}` })
    expect(viaKey.statusCode).toBe(200)
    const set = viaKey.cookies.find(c => c.name === 'admin')
    expect(set?.value).toBe(ADMIN)
    expect(set?.httpOnly).toBe(true)
    expect(set?.sameSite).toBe('Strict')

    const wrongCookie = await app.inject({ url: '/api/library', cookies: { admin: 'nope' } })
    expect(wrongCookie.statusCode).toBe(401)
  })

  it('rejects (401, not 500) a ?key= with the same JS length as adminToken but a different UTF-8 byte length', async () => {
    // 'é' is 1 UTF-16 code unit (matches ADMIN.length) but 2 bytes in UTF-8, so byte length differs from ADMIN's
    const evilKey = 'é' + 'x'.repeat(ADMIN.length - 1)
    expect(evilKey.length).toBe(ADMIN.length)
    const res = await app.inject({ url: `/api/library?key=${encodeURIComponent(evilKey)}` })
    expect(res.statusCode).toBe(401)
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

  it('rejects a segment variant outside the real range (0..audioCount) without touching the session', async () => {
    fakeSession.requestSegment.mockClear()
    const res = await app.inject({ url: `/stream/${token}/seg_99_00000.m4s` })
    expect(res.statusCode).toBe(404)
    expect(fakeSession.requestSegment).not.toHaveBeenCalled()
  })

  it('rejects an audio playlist / init file outside the real variant range', async () => {
    // fixture has 2 audio tracks -> valid variants are 0 (video) and 1..2 (audio)
    expect((await app.inject({ url: `/stream/${token}/audio_0.m3u8` })).statusCode).toBe(404)
    expect((await app.inject({ url: `/stream/${token}/audio_3.m3u8` })).statusCode).toBe(404)
    expect((await app.inject({ url: `/stream/${token}/audio_1.m3u8` })).statusCode).toBe(200)
    expect((await app.inject({ url: `/stream/${token}/init_3.mp4` })).statusCode).toBe(404)
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

  it('gif search is disabled (404) when no klipyApiKey is configured', async () => {
    const res = await app.inject({ url: `/api/gifs/search?q=lol&room=${token}` })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ gifsDisabled: true })
  })

  it('gif search rejects an invalid room token even when a key is configured', async () => {
    const gifApp = await buildApp({
      config: { mediaFolders: [mediaDir], klipyApiKey: 'fake-key', port: 8400, hostName: 'Host', cacheLimitGB: 10 },
      library: () => scanLibrary([mediaDir]),
      rooms,
      adminToken: ADMIN, tunnel: { url: null },
      fetchImpl: (async () => new Response(JSON.stringify({}))) as unknown as typeof fetch,
    })
    const res = await gifApp.inject({ url: '/api/gifs/search?q=lol&room=NOEXISTE' })
    expect(res.statusCode).toBe(401)
    await gifApp.close()
  })

  it('gif search proxies klipy via fetchImpl and maps the results', async () => {
    const sample = {
      result: true,
      data: {
        data: [{
          id: 123, title: 'lol',
          files: {
            sm: { gif: { url: 'https://k/sm.gif', width: 100, height: 80 } },
            md: { gif: { url: 'https://k/md.gif', width: 200, height: 160 } },
          },
        }],
        has_next: false,
      },
    }
    const gifApp = await buildApp({
      config: { mediaFolders: [mediaDir], klipyApiKey: 'fake-key', port: 8400, hostName: 'Host', cacheLimitGB: 10 },
      library: () => scanLibrary([mediaDir]),
      rooms,
      adminToken: ADMIN, tunnel: { url: null },
      fetchImpl: (async () => new Response(JSON.stringify(sample))) as unknown as typeof fetch,
    })
    const res = await gifApp.inject({ url: `/api/gifs/search?q=lol&room=${token}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().results).toHaveLength(1)
    expect(res.json().results[0]).toEqual({ id: '123', title: 'lol', previewUrl: 'https://k/sm.gif', url: 'https://k/md.gif', width: 200, height: 160 })
    await gifApp.close()
  })
})
