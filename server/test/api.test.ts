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

  it('room exposes TMDB meta and composed title when lookup succeeds', async () => {
    const meta = { title: 'La Gran Peli', year: 2020, overview: 'Sinopsis.', posterUrl: null, rating: 7.5, episodeTag: null, originalLang: 'en' }
    const metaRooms = new RoomManager({ createSession: () => fakeSession, lookupMeta: async () => meta })
    const metaApp = await buildApp({
      config: { mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 },
      library: () => scanLibrary([mediaDir]), rooms: metaRooms, adminToken: ADMIN, tunnel: { url: null },
    })
    const items = await scanLibrary([mediaDir])
    const room = await metaRooms.create(items[0])
    const res = await metaApp.inject({ url: `/api/rooms/${room.token}` })
    expect(res.json().title).toBe('La Gran Peli (2020)')
    expect(res.json().meta).toEqual(meta)
    await metaRooms.close(room.token)
    await metaApp.close()
  })

  it('lists and removes media folders (admin only, persisted)', async () => {
    const extraDir = mkdtempSync(join(tmpdir(), 'apimedia4-'))
    await makeFixtureMkv(extraDir)
    const cfg = { mediaFolders: [mediaDir, extraDir], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 }
    const folderApp = await buildApp({
      config: cfg, library: () => scanLibrary(cfg.mediaFolders), rooms, adminToken: ADMIN, tunnel: { url: null },
    })

    expect((await folderApp.inject({ url: '/api/config/folders' })).statusCode).toBe(401)
    const list = await folderApp.inject({ url: '/api/config/folders', ...admin })
    expect(list.json()).toEqual({ folders: [mediaDir, extraDir] })

    expect((await folderApp.inject({ method: 'DELETE', url: '/api/config/folders', payload: { path: extraDir } })).statusCode).toBe(401)
    const removed = await folderApp.inject({ method: 'DELETE', url: '/api/config/folders', payload: { path: extraDir }, ...admin })
    expect(removed.statusCode).toBe(200)
    expect(removed.json()).toHaveLength(1) // solo queda el item de mediaDir
    expect(cfg.mediaFolders).toEqual([mediaDir])
    expect(loadConfig().mediaFolders).toEqual([mediaDir]) // persistido

    // idempotente: quitar de nuevo no falla
    const again = await folderApp.inject({ method: 'DELETE', url: '/api/config/folders', payload: { path: extraDir }, ...admin })
    expect(again.statusCode).toBe(200)

    await folderApp.close()
  })

  it('pick-folder uses the injected native picker and adds the chosen dir', async () => {
    const cfg = { mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 }
    const pickedDir = mkdtempSync(join(tmpdir(), 'apimedia3-'))
    await makeFixtureMkv(pickedDir)
    let pick: string | null = pickedDir
    const pickApp = await buildApp({
      config: cfg, library: () => scanLibrary(cfg.mediaFolders), rooms, adminToken: ADMIN,
      tunnel: { url: null }, pickFolder: async () => pick,
    })

    expect((await pickApp.inject({ method: 'POST', url: '/api/config/pick-folder' })).statusCode).toBe(401)

    const res = await pickApp.inject({ method: 'POST', url: '/api/config/pick-folder', ...admin })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(2)
    expect(cfg.mediaFolders).toContain(pickedDir)

    pick = null // el usuario cancela el diálogo
    const cancelled = await pickApp.inject({ method: 'POST', url: '/api/config/pick-folder', ...admin })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json()).toEqual({ cancelled: true })

    await pickApp.close()
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

  it('rate-limits /retry to one call per room per 10s', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1_000_000)
    const first = await app.inject({ method: 'POST', url: `/api/rooms/${token}/retry` })
    expect(first.statusCode).toBe(200)

    nowSpy.mockReturnValue(1_005_000) // 5s later: still within the 10s cooldown
    const second = await app.inject({ method: 'POST', url: `/api/rooms/${token}/retry` })
    expect(second.statusCode).toBe(429)

    nowSpy.mockReturnValue(1_010_001) // just past the cooldown
    const third = await app.inject({ method: 'POST', url: `/api/rooms/${token}/retry` })
    expect(third.statusCode).toBe(200)

    nowSpy.mockRestore()
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
    // Traversal codificado: llega como valor del param :file y debe caer en el 404 del handler.
    expect((await app.inject({ url: `/stream/${token}/..%2F..%2Fetc%2Fpasswd` })).statusCode).toBe(404)
    // Traversal sin codificar: la URL se normaliza fuera de /stream (puede acabar en el SPA
    // fallback si web/dist existe); lo que importa es que el archivo del sistema nunca se sirva.
    const raw = await app.inject({ url: `/stream/${token}/../../etc/passwd` })
    expect(raw.body).not.toContain('root:')
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
