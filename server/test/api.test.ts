import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { RoomManager } from '../src/rooms/roomManager.js'
import { makeFixtureMkv } from './support/fixture.js'
import { scanLibrary } from '../src/library/scanner.js'

let app: Awaited<ReturnType<typeof buildApp>>, mediaDir: string, token: string, rooms: RoomManager
const ADMIN = 'test-admin-token'

const fakeSession = {
  start: () => {}, seekTo: () => {}, stop: async () => {}, onError: () => {}, lastLog: [] as string[],
  openSegment: vi.fn(async (_v: number, _i: number) => Readable.from([Buffer.from('seg-retimed')])),
  requestInit: vi.fn(async () => { throw new Error('no init') }),
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
    const res = await app.inject({ method: 'POST', url: '/api/config/folders', payload: { path: '/definitely/does/not/exist/xyz' }, ...admin })
    expect(res.statusCode).toBe(400)
  })

  it('requires admin to add a media folder', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/config/folders', payload: { path: mediaDir } })
    expect(res.statusCode).toBe(401)
  })

  it('room exposes TMDB meta and composed title when lookup succeeds', async () => {
    const meta = { title: 'The Big Movie', year: 2020, overview: 'Synopsis.', posterUrl: null, rating: 7.5, episodeTag: null, originalLang: 'en' }
    const metaRooms = new RoomManager({ createSession: () => fakeSession, lookupMeta: async () => meta })
    const metaApp = await buildApp({
      config: { mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 },
      library: () => scanLibrary([mediaDir]), rooms: metaRooms, adminToken: ADMIN, tunnel: { url: null },
    })
    const items = await scanLibrary([mediaDir])
    const room = await metaRooms.create(items[0])
    const res = await metaApp.inject({ url: `/api/rooms/${room.token}` })
    expect(res.json().media.title).toBe('The Big Movie (2020)')
    expect(res.json().media.meta).toEqual(meta)
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
    expect(removed.json()).toHaveLength(1) // only mediaDir's item is left
    expect(cfg.mediaFolders).toEqual([mediaDir])
    expect(loadConfig().mediaFolders).toEqual([mediaDir]) // persisted

    // idempotent: removing again does not fail
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

    pick = null // the user cancels the dialog
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
    expect(info.media.epoch).toBe(1)
    // The movie picker identifies the one now playing by this id: the room's
    // title goes through displayTitle and does not match the item's.
    expect(info.media.itemId).toBe(items[0].id)
    expect(info.media.audio).toHaveLength(2)
    expect(info.media.subtitles.length).toBeGreaterThanOrEqual(1)
    expect(info.error).toBeNull()
    // With no streamBaseUrl configured the client must stay on the same origin.
    expect(info.streamBase).toBe('')
  })

  it('announces the relay origin when streamBaseUrl is set', async () => {
    const relayApp = await buildApp({
      config: {
        mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10,
        streamBaseUrl: 'https://stream.example.com',
      },
      library: () => scanLibrary([mediaDir]), rooms, adminToken: ADMIN, tunnel: { url: null },
    })
    const info = (await relayApp.inject({ url: `/api/rooms/${token}` })).json()
    expect(info.streamBase).toBe('https://stream.example.com')
    await relayApp.close()
  })

  // With the video on another origin, hls.js and the <track>s fetch it
  // cross-origin: without these headers the browser discards the response with no
  // visible error.
  it('allows CORS on the data plane, preflight included', async () => {
    const seg = await app.inject({ url: `/stream/${token}/e1/seg_0_00000.m4s` })
    expect(seg.headers['access-control-allow-origin']).toBe('*')
    const master = await app.inject({ url: `/stream/${token}/e1/master.m3u8` })
    expect(master.headers['access-control-allow-origin']).toBe('*')

    const pre = await app.inject({ method: 'OPTIONS', url: `/stream/${token}/e1/seg_0_00000.m4s` })
    expect(pre.statusCode).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBe('*')
    expect(pre.headers['access-control-allow-methods']).toContain('GET')
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
    const m = await app.inject({ url: `/stream/${token}/e1/master.m3u8` })
    expect(m.statusCode).toBe(200)
    expect(m.body).toContain('audio_1.m3u8')
    const v = await app.inject({ url: `/stream/${token}/e1/video.m3u8` })
    expect(v.body).toContain('#EXT-X-ENDLIST')
  })

  it('serves segments via session and rejects weird paths', async () => {
    const s = await app.inject({ url: `/stream/${token}/e1/seg_0_00000.m4s` })
    expect(s.statusCode).toBe(200)
    // Encoded traversal: it arrives as the :file param's value and must land in the handler's 404.
    expect((await app.inject({ url: `/stream/${token}/e1/..%2F..%2Fetc%2Fpasswd` })).statusCode).toBe(404)
    // Unencoded traversal: the URL is normalized outside /stream (it may end up in the SPA
    // fallback when web/dist exists); what matters is that the system file is never served.
    const raw = await app.inject({ url: `/stream/${token}/e1/../../etc/passwd` })
    expect(raw.body).not.toContain('root:')
    expect((await app.inject({ url: `/stream/${token}/e1/evil.txt` })).statusCode).toBe(404)
    expect((await app.inject({ url: `/stream/NOSUCHROOM/e1/master.m3u8` })).statusCode).toBe(404)
  })

  it('the segment is served through openSegment, which is what anchors it in time', async () => {
    const s = await app.inject({ url: `/stream/${token}/e1/seg_0_00000.m4s` })
    expect(s.statusCode).toBe(200)
    expect(s.body).toBe('seg-retimed')
    expect(fakeSession.openSegment).toHaveBeenCalledWith(0, 0)
  })

  it('rejects a segment variant outside the real range (0..audioCount) without touching the session', async () => {
    fakeSession.openSegment.mockClear()
    const res = await app.inject({ url: `/stream/${token}/e1/seg_99_00000.m4s` })
    expect(res.statusCode).toBe(404)
    expect(fakeSession.openSegment).not.toHaveBeenCalled()
  })

  // With the ffmpeg process already finished, requestSegment resolves on
  // existsSync alone: a request for an index outside the plan would resolve and
  // fall into the silent fallback this fix exists to kill. A made-up index has to
  // 404 without touching the session, just like the variant.
  it('rejects a segment index outside the plan (0..segments.length) without touching the session', async () => {
    fakeSession.openSegment.mockClear()
    const room = rooms.get(token)!
    const outOfRange = String(room.media!.segments.length).padStart(5, '0')
    const res = await app.inject({ url: `/stream/${token}/e1/seg_0_${outOfRange}.m4s` })
    expect(res.statusCode).toBe(404)
    expect(fakeSession.openSegment).not.toHaveBeenCalled()
  })

  it('rejects an audio playlist / init file outside the real variant range', async () => {
    // fixture has 2 audio tracks -> valid variants are 0 (video) and 1..2 (audio)
    expect((await app.inject({ url: `/stream/${token}/e1/audio_0.m3u8` })).statusCode).toBe(404)
    expect((await app.inject({ url: `/stream/${token}/e1/audio_3.m3u8` })).statusCode).toBe(404)
    expect((await app.inject({ url: `/stream/${token}/e1/audio_1.m3u8` })).statusCode).toBe(200)
    expect((await app.inject({ url: `/stream/${token}/e1/init_3.mp4` })).statusCode).toBe(404)
  })

  // With a single track the audio rides inside the video variant (hlsLayout.ts):
  // there is no variant 1, so asking for it must be a flat 404. Without this
  // guard the request would reach the session, which would wait 30 s for a file
  // ffmpeg is never going to write.
  it('exposes a single variant when the source has one audio track', async () => {
    const monoDir = mkdtempSync(join(tmpdir(), 'apimono-'))
    await makeFixtureMkv(monoDir, { audioTracks: 1 })
    const monoApp = await buildApp({
      config: { mediaFolders: [monoDir], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 },
      library: () => scanLibrary([monoDir]), rooms, adminToken: ADMIN, tunnel: { url: null },
    })
    const item = (await scanLibrary([monoDir]))[0]
    const created = await monoApp.inject({ method: 'POST', url: '/api/rooms', payload: { itemId: item.id }, ...admin })
    const mono = created.json().token

    const master = await monoApp.inject({ url: `/stream/${mono}/e1/master.m3u8` })
    expect(master.body).not.toContain('#EXT-X-MEDIA')
    expect(master.body).not.toContain('audio_1.m3u8')

    fakeSession.openSegment.mockClear()
    expect((await monoApp.inject({ url: `/stream/${mono}/e1/audio_1.m3u8` })).statusCode).toBe(404)
    expect((await monoApp.inject({ url: `/stream/${mono}/e1/seg_1_00000.m4s` })).statusCode).toBe(404)
    expect((await monoApp.inject({ url: `/stream/${mono}/e1/init_1.mp4` })).statusCode).toBe(404)
    expect(fakeSession.openSegment).not.toHaveBeenCalled()
    expect((await monoApp.inject({ url: `/stream/${mono}/e1/seg_0_00000.m4s` })).statusCode).toBe(200)

    await monoApp.close()
  })

  it('404s (without leaking the filesystem path) for roomDir files missing on disk', async () => {
    // sub id that was never extracted to disk (extractSubtitle failed silently, or id simply doesn't exist)
    const missingSub = await app.inject({ url: `/stream/${token}/e1/sub_999.vtt` })
    expect(missingSub.statusCode).toBe(404)
    expect(missingSub.body).not.toContain(process.env.JBG_DATA_DIR!)

    // The init is no longer looked up on disk from the route: it is asked of the
    // session, which answers "not yet" by exhausting the deadline. That is a 504
    // (not ready), not a 404 (does not exist); 404 is left for out-of-range
    // variants.
    const missingInit = await app.inject({ url: `/stream/${token}/e1/init_0.mp4` })
    expect(missingInit.statusCode).toBe(504)
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
    const res = await gifApp.inject({ url: '/api/gifs/search?q=lol&room=NOSUCHROOM' })
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

  it('creates an empty room when no itemId is sent', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: {}, ...admin })
    expect(res.statusCode).toBe(200)
    const empty = res.json().token

    const info = (await app.inject({ url: `/api/rooms/${empty}` })).json()
    expect(info.media).toBeNull()
    expect(info.error).toBeNull()
    expect(info.streamBase).toBe('')

    // Without a movie the data plane does not exist in any of its forms.
    for (const file of ['master.m3u8', 'video.m3u8', 'audio_1.m3u8', 'init_0.mp4', 'seg_0_00000.m4s', 'sub_0.vtt']) {
      expect((await app.inject({ url: `/stream/${empty}/e1/${file}` })).statusCode).toBe(404)
    }
    await rooms.close(empty)
  })

  it('the empty room shows up in /api/status with no movie title', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: {}, ...admin })
    const empty = res.json().token
    const status = (await app.inject({ url: '/api/status', ...admin })).json()
    expect(status.rooms.find((r: any) => r.token === empty).title).toBe('No movie')
    await rooms.close(empty)
  })

  it('changing the movie requires admin', async () => {
    const items = (await app.inject({ url: '/api/library', ...admin })).json()
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${token}/media`, payload: { itemId: items[0].id } })
    expect(res.statusCode).toBe(401)
  })

  it('changing the movie rejects a non-existent item and a non-existent room', async () => {
    expect((await app.inject({
      method: 'POST', url: `/api/rooms/${token}/media`, payload: { itemId: 'no-such-item' }, ...admin,
    })).statusCode).toBe(404)
    expect((await app.inject({
      method: 'POST', url: '/api/rooms/NOSUCHROOM/media', payload: { itemId: 'x' }, ...admin,
    })).statusCode).toBe(404)
  })

  // Without this validation the endpoint would be an arbitrary file reader for
  // anyone holding the cookie: it is not inherited from POST /api/rooms, it has
  // to be repeated.
  it('changing the movie rejects an item outside the media folders', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'apioutside-'))
    await makeFixtureMkv(outsideDir)
    const outside = (await scanLibrary([outsideDir]))[0]
    const wideApp = await buildApp({
      config: { mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 },
      // The library declares the item, but mediaFolders does NOT contain it.
      library: async () => [...await scanLibrary([mediaDir]), outside],
      rooms, adminToken: ADMIN, tunnel: { url: null },
    })

    const res = await wideApp.inject({
      method: 'POST', url: `/api/rooms/${token}/media`, payload: { itemId: outside.id }, ...admin,
    })
    expect(res.statusCode).toBe(400)

    await wideApp.close()
  })

  it('an earlier generation\'s epoch gives 410 (with CORS) and a malformed one gives 404', async () => {
    const items = (await app.inject({ url: '/api/library', ...admin })).json()
    const changed = await app.inject({
      method: 'POST', url: `/api/rooms/${token}/media`, payload: { itemId: items[0].id, by: 'Alex' }, ...admin,
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json().epoch).toBe(2)

    const stale = await app.inject({ url: `/stream/${token}/e1/master.m3u8` })
    expect(stale.statusCode).toBe(410)
    // A cross-origin 410 without CORS headers is a mute failure in the browser.
    expect(stale.headers['access-control-allow-origin']).toBe('*')

    expect((await app.inject({ url: `/stream/${token}/e2/master.m3u8` })).statusCode).toBe(200)
    // 'e01' and 'e02' are the generations written with a leading zero: `Number`
    // would accept them (`Number('02') === 2`, and 'e02' would go on to serve the
    // current generation's bytes), and each variant is a distinct cache key for
    // the same bytes on the video relay.
    for (const bad of ['1', 'x2', 'e', 'ee2', 'e01', 'e02']) {
      expect((await app.inject({ url: `/stream/${token}/${bad}/master.m3u8` })).statusCode).toBe(404)
    }

    const info = (await app.inject({ url: `/api/rooms/${token}` })).json()
    expect(info.media.epoch).toBe(2)
  })

  it('the CORS preflight covers the versioned route', async () => {
    const pre = await app.inject({ method: 'OPTIONS', url: `/stream/${token}/e2/seg_0_00000.m4s` })
    expect(pre.statusCode).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBe('*')
    expect(pre.headers['access-control-allow-methods']).toContain('GET')
  })

  it('retry returns 409 on a room with no movie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: {}, ...admin })
    const empty = res.json().token
    const retry = await app.inject({ method: 'POST', url: `/api/rooms/${empty}/retry` })
    expect(retry.statusCode).toBe(409)
    await rooms.close(empty)
  })
})
