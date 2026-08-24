import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { RoomManager, RoomBusyError } from '../src/rooms/roomManager.js'
import { scanLibrary } from '../src/library/scanner.js'
import { makeFixtureMkv } from './support/fixture.js'

const fakeSession = () => ({
  start: () => {}, seekTo: () => {}, stop: async () => {}, onError: () => {},
  lastLog: [] as string[],
  openSegment: async () => Readable.from([]),
  requestInit: async () => '',
})

let rooms: RoomManager
let items: Awaited<ReturnType<typeof scanLibrary>>
let monoItems: Awaited<ReturnType<typeof scanLibrary>>

beforeAll(async () => {
  process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'rm-'))
  const mediaDir = mkdtempSync(join(tmpdir(), 'rmmedia-'))
  await makeFixtureMkv(mediaDir)
  rooms = new RoomManager({ createSession: () => fakeSession() })
  items = await scanLibrary([mediaDir])
  const monoDir = mkdtempSync(join(tmpdir(), 'rmmono-'))
  await makeFixtureMkv(monoDir, { audioTracks: 1 })
  monoItems = await scanLibrary([monoDir])
})

// The segment grid and ffmpeg's mode are ONE contract: in copy mode the video
// can only be cut at the source's keyframes, and in transcode mode ffmpeg forces
// its own every 4 s (see ffmpegArgs.ts). Planning with the wrong grid makes the
// playlist describe cuts the file does not have, which is exactly what broke the
// audio.
describe('RoomManager.create plans the grid the chosen mode will actually produce', () => {
  const capturing = () => {
    const modes: ('copy' | 'transcode')[] = []
    const manager = new RoomManager({
      createSession: (_i, _info, _segs, _dir, mode) => { modes.push(mode); return fakeSession() },
    })
    return { manager, modes }
  }

  it('plans the uniform 4s grid ffmpeg will force, for one audio track', async () => {
    const { manager, modes } = capturing()
    const room = await manager.create(monoItems[0])
    expect(modes).toEqual(['transcode'])
    expect(room.media!.segments.map(s => s.start)).toEqual([0, 4, 8])
  })

  it('plans the uniform 4s grid ffmpeg will force, for several audio tracks', async () => {
    const { manager, modes } = capturing()
    const room = await manager.create(items[0])
    expect(modes).toEqual(['transcode'])
    expect(room.media!.segments.map(s => s.start)).toEqual([0, 4, 8])
  })

  // The SOURCE's keyframes no longer decide anything: ffmpeg is going to place
  // its own every 4 s. Planning with them was exactly what produced a playlist
  // with fewer segments than ffmpeg wrote.
  it('does not let the source keyframes shape the grid', async () => {
    const { manager } = capturing()
    const room = await manager.create(monoItems[0])
    for (const s of room.media!.segments.slice(0, -1)) expect(s.duration).toBe(4)
    for (const s of room.media!.segments) expect(s.seekAt).toBe(s.start)
  })
})

describe('RoomManager.retry', () => {
  // A snapshot of the broken run surviving the retry would be served forever:
  // requestInit stops the moment it sees the .stable.mp4 on disk.
  it('deletes stale init snapshots so a broken run cannot survive the retry', async () => {
    const room = await rooms.create(items[0])
    const stale = join(room.media!.dir, 'init_0.stable.mp4')
    writeFileSync(stale, 'broken')
    const previous = room.media!.session

    await rooms.retry(room.token)

    expect(existsSync(stale)).toBe(false)
    expect(room.media!.session).not.toBe(previous)
  })

  // A live .m4s or init_*.mp4 from the broken run can convince the new session's
  // requestInit() that its own init is already complete (see transcoder.ts), and
  // if the retry moved from copy to transcode that old init carries the source's
  // SPS/PPS while the new segments carry libx264's. The extracted subtitles are
  // still valid: a retry does not regenerate them, so they must survive.
  it('deletes stale segments and init files but keeps extracted subtitles', async () => {
    const room = await rooms.create(items[0])
    const staleSegment = join(room.media!.dir, 'seg_0_00000.m4s')
    const staleInit = join(room.media!.dir, 'init_0.mp4')
    const staleSub = join(room.media!.dir, 'sub_0.vtt')
    writeFileSync(staleSegment, 'broken')
    writeFileSync(staleInit, 'broken')
    writeFileSync(staleSub, 'WEBVTT\n')

    await rooms.retry(room.token)

    expect(existsSync(staleSegment)).toBe(false)
    expect(existsSync(staleInit)).toBe(false)
    expect(existsSync(staleSub)).toBe(true)
  })

  // A retry stands the session up from scratch, and the grid the room serves
  // afterwards still has to be the one ffmpeg is going to produce.
  it('re-plans the grid, so the playlist keeps matching what the new run will cut', async () => {
    const modes: ('copy' | 'transcode')[] = []
    const manager = new RoomManager({
      createSession: (_i, _info, _segs, _dir, mode) => { modes.push(mode); return fakeSession() },
    })
    const room = await manager.create(monoItems[0])

    await manager.retry(room.token)

    expect(modes).toEqual(['transcode', 'transcode'])
    expect(room.media!.segments.map(s => s.start)).toEqual([0, 4, 8])
  })
})

describe('RoomManager without a movie', () => {
  it('creates the room without touching ffmpeg or ffprobe', async () => {
    let sessions = 0
    const manager = new RoomManager({ createSession: () => { sessions++; return fakeSession() } })

    const room = await manager.create()

    expect(room.media).toBeNull()
    expect(sessions).toBe(0)
    expect(room.state.paused).toBe(true)
    expect(room.state.positionBase).toBe(0)
    expect(existsSync(room.dir)).toBe(true)
  })

  it('setMedia populates info, segments, subtitles and metadata, and starts at epoch 1', async () => {
    const meta = { title: 'The Movie', year: 2020, overview: '', posterUrl: null, rating: null, episodeTag: null, originalLang: 'en' }
    const manager = new RoomManager({ createSession: () => fakeSession(), lookupMeta: async () => meta })
    const room = await manager.create()

    const media = await manager.setMedia(room.token, items[0], 'Alex')

    expect(media.epoch).toBe(1)
    expect(media.setBy).toBe('Alex')
    expect(media.info.audio).toHaveLength(2)
    expect(media.segments.map(s => s.start)).toEqual([0, 4, 8])
    expect(media.subtitles.length).toBeGreaterThanOrEqual(1)
    expect(media.meta).toEqual(meta)
    expect(room.media).toBe(media)
    // Everything about the movie lives in the epoch's directory, not the room's
    // root: that is what lets a single rmSync drop the previous generation.
    expect(media.dir).toBe(join(room.dir, 'e1'))
  })

  it('the second setMedia bumps the epoch, stops the old session and deletes its directory', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    const first = room.media!
    let stopped = false
    first.session.stop = async () => { stopped = true }
    // A marker in the old directory: were it to survive, the new session's
    // requestInit could serve an init from the previous movie.
    writeFileSync(join(first.dir, 'init_0.stable.mp4'), 'old')

    const second = await manager.setMedia(room.token, monoItems[0])

    expect(stopped).toBe(true)
    expect(second.epoch).toBe(2)
    expect(second.dir).toBe(join(room.dir, 'e2'))
    expect(existsSync(first.dir)).toBe(false)
    expect(second.setBy).toBeNull()
  })

  it('resets playback and the error when the movie changes', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    room.state = { paused: false, positionBase: 500, updatedAt: 1, stalled: true }
    room.error = ['ffmpeg: boom']

    await manager.setMedia(room.token, monoItems[0])

    expect(room.state.paused).toBe(true)
    expect(room.state.positionBase).toBe(0)
    expect(room.state.stalled).toBe(false)
    expect(room.error).toBeNull()
  })

  it('notifies the mediaListeners with the new media', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create()
    const seen: number[] = []
    room.mediaListeners.add(m => seen.push(m.epoch))

    await manager.setMedia(room.token, items[0])
    await manager.setMedia(room.token, monoItems[0])

    expect(seen).toEqual([1, 2])
  })

  // If the fan-out does not guard each call separately, a broken listener takes
  // down everyone behind it in the Set: the movie change already happened
  // (room.media is the new one) but nobody after the broken one finds out.
  it('a mediaListener that throws does not stop setMedia resolving or the others finding out', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create()
    const seenByOther: number[] = []
    room.mediaListeners.add(() => { throw new Error('broken listener') })
    room.mediaListeners.add(m => seenByOther.push(m.epoch))

    const media = await manager.setMedia(room.token, items[0])

    expect(media.epoch).toBe(1)
    expect(room.media).toBe(media)
    expect(seenByOther).toEqual([1])
  })

  // A file ffprobe cannot read must not leave the room half-built: the previous
  // movie has to keep playing and the new directory must not be left behind in
  // the cache.
  it('an unreadable file leaves the previous movie untouched', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    const before = room.media!
    let stopped = false
    // If prepareMedia ran after stopping the old session (rather than before),
    // this test would still be green with the room gone silent: hence stop() is
    // instrumented and checked to be called NEVER.
    before.session.stop = async () => { stopped = true }
    const brokenDir = mkdtempSync(join(tmpdir(), 'rmbroken-'))
    writeFileSync(join(brokenDir, 'broken.mkv'), 'this is not a video')
    const broken = (await scanLibrary([brokenDir]))[0]

    await expect(manager.setMedia(room.token, broken)).rejects.toThrow()

    expect(room.media).toBe(before)
    expect(room.media!.epoch).toBe(1)
    expect(existsSync(before.dir)).toBe(true)
    expect(existsSync(join(room.dir, 'e2'))).toBe(false)
    expect(stopped).toBe(false)
  })

  it('rejects a second change while one is in flight', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create()

    const first = manager.setMedia(room.token, items[0])
    await expect(manager.setMedia(room.token, monoItems[0])).rejects.toBeInstanceOf(RoomBusyError)
    await first

    expect(room.media!.epoch).toBe(1)
  })

  it('releases busy after a failed setMedia: the next attempt with a good file works', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    const brokenDir = mkdtempSync(join(tmpdir(), 'rmbroken3-'))
    writeFileSync(join(brokenDir, 'broken.mkv'), 'this is not a video')
    const broken = (await scanLibrary([brokenDir]))[0]

    await expect(manager.setMedia(room.token, broken)).rejects.toThrow()
    const media = await manager.setMedia(room.token, monoItems[0])

    expect(media.epoch).toBe(2)
  })

  // busy is the only lock shared between setMedia and retry: if retry did not
  // raise it, this direction (retry in flight → setMedia) would not be rejected
  // and the two sessions would end up fighting over the same directory.
  it('a retry in flight blocks a setMedia with RoomBusyError', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    let releaseStop: () => void = () => {}
    // stop() hangs on purpose: because room.busy is set to true synchronously
    // before this await (same pattern as setMedia), the retry has already marked
    // the room busy by the time this line returns, without relying on timers or
    // sleeps.
    room.media!.session.stop = () => new Promise<void>(resolve => { releaseStop = resolve })

    const retrying = manager.retry(room.token)
    await expect(manager.setMedia(room.token, monoItems[0])).rejects.toBeInstanceOf(RoomBusyError)

    releaseStop()
    await retrying
  })

  it('retry is a no-op without a movie, and close works without one', async () => {
    let sessions = 0
    const manager = new RoomManager({ createSession: () => { sessions++; return fakeSession() } })
    const room = await manager.create()

    await manager.retry(room.token)
    expect(sessions).toBe(0)

    await manager.close(room.token)
    expect(manager.get(room.token)).toBeUndefined()
    expect(existsSync(room.dir)).toBe(false)
  })

  // create(item) is create() + setMedia(): if the probe fails, no phantom room
  // with media set to null may be left in the map.
  it('create(item) leaves no room behind when preparation fails', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const brokenDir = mkdtempSync(join(tmpdir(), 'rmbroken2-'))
    writeFileSync(join(brokenDir, 'broken.mkv'), 'this is not a video')
    const broken = (await scanLibrary([brokenDir]))[0]

    await expect(manager.create(broken)).rejects.toThrow()

    expect(manager.all()).toHaveLength(0)
  })
})
