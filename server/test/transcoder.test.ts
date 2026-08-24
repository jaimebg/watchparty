import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import ffprobeStatic from 'ffprobe-static'
import { makeFixtureMkv } from './support/fixture.js'
import { extractKeyframes, probeFile } from '../src/media/probe.js'
import { planSegments } from '../src/media/planner.js'
import { TranscodeSession } from '../src/media/transcoder.js'
import { parseBoxes, type Box } from '../src/media/fmp4.js'
import { run } from './support/run.js'

// Wraps createReadStream (without changing its behaviour: it forwards to the
// real implementation) so the stream openSegment opens for the `mdat` can be
// observed from outside, and a consumer abort can be checked to destroy it —
// the dangling-fd regression this mock exists to watch.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

let fixture: string, session: TranscodeSession, outDir: string

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

// media_time of a trak's elst entries (or [] when it has no edts). The codec
// delay trim survives canonicalizeInit (it does not depend on the run), so an
// `edts` being present is not on its own proof of anything; what cannot survive
// is an entry with media_time==-1 (the empty edit that records where THAT
// process started).
function elstMediaTimes(buf: Buffer, trak: Box): number[] {
  const edtsBox = parseBoxes(buf, trak.start + trak.hdr, trak.start + trak.size).find(b => b.type === 'edts')
  if (!edtsBox) return []
  const elst = parseBoxes(buf, edtsBox.start + edtsBox.hdr, edtsBox.start + edtsBox.size)[0]
  const version = buf[elst.start + elst.hdr]
  const count = buf.readUInt32BE(elst.start + elst.hdr + 4)
  const entrySize = version === 1 ? 20 : 12
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const at = elst.start + elst.hdr + 8 + i * entrySize
    out.push(version === 1 ? Number(buf.readBigInt64BE(at + 8)) : buf.readInt32BE(at + 4))
  }
  return out
}

// start_time of each track in an fMP4, which is only playable with its init in
// front. This is the measurement that matters: it is where hls.js places the
// segment.
async function startTimes(dir: string, init: Buffer, seg: Buffer): Promise<number[]> {
  const joined = join(dir, `joined-${randomBytes(4).toString('hex')}.mp4`)
  writeFileSync(joined, Buffer.concat([init, seg]))
  const { stdout } = await run(ffprobeStatic.path, [
    '-v', 'error', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', joined,
  ])
  return stdout.trim().split('\n').map(Number)
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-'))
  fixture = await makeFixtureMkv(dir, { seconds: 30, withSubs: false })
  outDir = join(dir, 'out'); mkdirSync(outDir)
  const info = await probeFile(fixture)
  const kf = await extractKeyframes(fixture)
  session = new TranscodeSession({
    input: fixture, mode: 'copy', encoder: 'libx264',
    segments: planSegments(info.durationSec, kf), audioCount: 2, outDir,
  })
})
afterAll(async () => { await session?.stop() })

describe('TranscodeSession', () => {
  it('produces early video and audio segments', async () => {
    session.start()
    const v0 = await session.requestSegment(0, 0)
    expect(existsSync(v0)).toBe(true)
    expect(existsSync(await session.requestSegment(1, 0))).toBe(true)
    expect(existsSync(await session.requestSegment(2, 1))).toBe(true)
    expect(existsSync(join(outDir, 'init_0.mp4'))).toBe(true)
  })

  it('requesting a segment behind the current start forces a genuine seekTo restart', async () => {
    // Starting session.start() at 0 and later asking for a late segment never
    // exercises seekTo(): a "copy"-mode remux of the 30s fixture finishes
    // almost instantly, so by the time the later segment is requested it is
    // already on disk from the original process. To force a real kill+restart
    // we start a fresh session at a mid segment and then ask for an earlier
    // one that the mid-start process can never produce on its own (it only
    // encodes forward from its -ss point), which must trigger seekTo().
    const segments = session['segments']
    const midIndex = Math.floor(segments.length / 2)
    const earlierIndex = 1 // != 0, so success also proves -start_number isn't just defaulting to 0
    expect(earlierIndex).toBeLessThan(midIndex)

    const seekOutDir = join(mkdtempSync(join(tmpdir(), 'tsc-seek-')), 'out')
    mkdirSync(seekOutDir)
    const seekSession = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264', segments, audioCount: 2, outDir: seekOutDir,
    })
    const seekSpy = vi.spyOn(seekSession, 'seekTo')

    seekSession.start(midIndex)
    await seekSession.requestSegment(0, midIndex, 20_000)
    const oldProc = seekSession['proc']
    expect(oldProc).not.toBeNull()

    const earlierPath = join(seekOutDir, `seg_0_${String(earlierIndex).padStart(5, '0')}.m4s`)
    expect(existsSync(earlierPath)).toBe(false) // the mid-start process never produces this

    const p = await seekSession.requestSegment(0, earlierIndex, 45_000)

    expect(seekSpy).toHaveBeenCalledWith(earlierIndex) // seekTo genuinely ran
    expect(p).toBe(earlierPath) // restarted numbering at earlierIndex via -start_number
    expect(existsSync(p)).toBe(true)
    expect(seekSession['proc']).not.toBe(oldProc) // old process was replaced
    // The old process is dead either because seekTo SIGKILLed it or because a
    // fast copy-mode remux finished on its own before the seek arrived — both
    // are valid; asserting killed===true races against ffmpeg's own exit.
    expect(oldProc?.killed || oldProc?.exitCode !== null || oldProc?.signalCode !== null).toBe(true)

    await seekSession.stop()
  }, 90_000)

  it('seekTo into an already-cached segment keeps the current process (no restart)', async () => {
    // Restarting ffmpeg over a cached region would regenerate segments that are
    // already servable and rewrite init_*.mp4 under clients' feet, so a seek
    // whose target (every variant) is ready must leave the process alone.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-cached-'))
    const cachedOutDir = join(dir, 'out'); mkdirSync(cachedOutDir)
    const cachedSession = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264',
      segments: session['segments'], audioCount: 2, outDir: cachedOutDir,
    })
    cachedSession.start()
    for (const variant of [0, 1, 2]) await cachedSession.requestSegment(variant, 1, 20_000)
    const proc = cachedSession['proc']
    expect(proc).not.toBeNull()

    cachedSession.seekTo(1)
    expect(cachedSession['proc']).toBe(proc)

    await cachedSession.stop()
  }, 60_000)

  it('seekTo to the segment the live process already started from does not restart it', async () => {
    // Video and audio request the same index: if every request restarted ffmpeg
    // they would kill each other in a loop and that segment would never appear.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-same-'))
    const sameOutDir = join(dir, 'out'); mkdirSync(sameOutDir)
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264', segments, audioCount: 2, outDir: sameOutDir,
    })
    s.start(mid)
    const proc = s['proc']
    expect(proc).not.toBeNull()

    s.seekTo(mid)
    expect(s['proc']).toBe(proc)

    await s.stop()
  }, 60_000)

  it('a segment far ahead of the working point restarts ffmpeg there instead of timing out', async () => {
    // Without this, the client waits the full 30 s for a segment nobody is
    // producing and ends up with a 504.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-fwd-'))
    const fwdOutDir = join(dir, 'out'); mkdirSync(fwdOutDir)
    const segments = session['segments']
    const late = segments.length - 1
    expect(late).toBeGreaterThan(1)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264', segments, audioCount: 2, outDir: fwdOutDir,
    })
    const seekSpy = vi.spyOn(s, 'seekTo')
    s.start(0)
    // The process is killed by hand so nothing advances toward `late`: the real
    // situation where ffmpeg fell far behind the room clock.
    s['proc']?.kill('SIGKILL')
    await new Promise(r => setTimeout(r, 300))

    const p = await s.requestSegment(0, late, 45_000)
    expect(seekSpy).toHaveBeenCalledWith(late)
    expect(existsSync(p)).toBe(true)

    await s.stop()
  }, 90_000)

  it('stop() closes the session so later start()/seekTo() calls no-op instead of respawning ffmpeg', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsc-closed-'))
    const closedOutDir = join(dir, 'out'); mkdirSync(closedOutDir)
    const info = await probeFile(fixture)
    const kf = await extractKeyframes(fixture)
    const closedSession = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264',
      segments: planSegments(info.durationSec, kf), audioCount: 2, outDir: closedOutDir,
    })
    closedSession.start()
    await closedSession.requestSegment(0, 0)
    expect(closedSession['proc']).not.toBeNull()

    await closedSession.stop()
    expect(closedSession['proc']).toBeNull()

    closedSession.seekTo(1)
    expect(closedSession['proc']).toBeNull() // no respawn: closed session ignores seekTo()

    closedSession.start(0)
    expect(closedSession['proc']).toBeNull() // no respawn: closed session ignores start()
  })

  it('requestInit hands out a snapshot that survives ffmpeg rewriting the live init file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsc-init-'))
    const initOutDir = join(dir, 'out'); mkdirSync(initOutDir)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264',
      segments: session['segments'], audioCount: 2, outDir: initOutDir,
    })
    s.start()
    const p = await s.requestInit(0, 30_000)
    expect(p).toBe(join(initOutDir, 'init_0.stable.mp4'))
    const snapshot = readFileSync(p)
    expect(snapshot.length).toBeGreaterThan(0)

    // Simulates an ffmpeg restart by leaving the live init half-written: the
    // snapshot already handed out must be unaffected.
    writeFileSync(join(initOutDir, 'init_0.mp4'), Buffer.alloc(3))
    expect(await s.requestInit(0, 5_000)).toBe(p)
    expect(readFileSync(p).equals(snapshot)).toBe(true)

    await s.stop()
  }, 60_000)

  it('the init handed out is canonical and does not depend on the run that produced it', async () => {
    // The bb67bc0 bug: ffmpeg records in the init's edts the position where THAT
    // process started, and the server pins one init for the whole room. If the
    // init remembers its run, segments from any other restart land at the wrong
    // offset.
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const paths: string[] = []
    for (const [name, from] of [['from0', 0], ['mid', mid]] as const) {
      const dir = mkdtempSync(join(tmpdir(), `tsc-canon-${name}-`))
      const out = join(dir, 'out'); mkdirSync(out)
      // audioCount 1 → a single variant with the audio INSIDE the video segment
      // (see hlsLayout.ts), which is how a normal room runs and the only case
      // where init 0 has two tracks to check.
      const s = new TranscodeSession({
        input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 1, outDir: out,
      })
      s.start(from)
      paths.push(await s.requestInit(0, 30_000))
      await s.stop()
    }

    const [from0, fromMid] = paths.map(p => readFileSync(p))
    // No trak keeps the -ss empty edit (media_time==-1). The edts itself may
    // survive: the codec delay trim does not depend on the run and has to be
    // kept so retimeHeader nails the tfdt without leaving video systematically
    // late (see canonicalizeInit in fmp4.ts).
    const moov = parseBoxes(from0).find(b => b.type === 'moov')!
    for (const t of parseBoxes(from0, moov.start + moov.hdr, moov.start + moov.size)) {
      if (t.type !== 'trak') continue
      const mediaTimes = elstMediaTimes(from0, t)
      expect(mediaTimes).not.toContain(-1)
      // [] does not contain -1 either: without this, reverting to "drop the
      // whole edts" — the exact defect from bb67bc0 that this fix corrects —
      // would leave this test green anyway, because both tracks of a real
      // libx264 run keep a trim entry (video [0,1024], audio [0,0]).
      expect(mediaTimes.length).toBeGreaterThan(0)
    }
    // And both runs produce exactly the same init.
    expect(fromMid.equals(from0)).toBe(true)
  }, 120_000)

  it('a segment from a restarted run lands in its place using ANOTHER run\'s init', async () => {
    // Exactly the bug reported in bb67bc0: the room starts at 0, pins that init,
    // the host jumps to the middle of the movie and ffmpeg restarts. Measured
    // before this fix: the segment decoded at 0:00:00 instead of at its minute.
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)

    const dirA = mkdtempSync(join(tmpdir(), 'tsc-open-a-'))
    const outA = join(dirA, 'out'); mkdirSync(outA)
    // audioCount 1 → the audio rides inside the video segment, so startTimes()
    // returns both tracks and checks lip sync along the way.
    const a = new TranscodeSession({
      input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 1, outDir: outA,
    })
    a.start(0)
    const pinnedInit = readFileSync(await a.requestInit(0, 30_000))
    await a.stop()

    const dirB = mkdtempSync(join(tmpdir(), 'tsc-open-b-'))
    const outB = join(dirB, 'out'); mkdirSync(outB)
    const b = new TranscodeSession({
      input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 1, outDir: outB,
    })
    b.start(mid)
    const seg = await drain(await b.openSegment(0, mid, 30_000))
    await b.stop()

    // The init comes from run A and the segment from run B: the crossover that broke.
    const times = await startTimes(dirB, pinnedInit, seg)
    expect(times).toHaveLength(2) // video and audio, both inside the segment
    for (const t of times) {
      expect(Math.abs(t - segments[mid].start)).toBeLessThan(0.05)
    }
  }, 120_000)

  it('openSegment destroys the mdat stream when the consumer aborts the download (no dangling fd)', async () => {
    // hls.js aborts a segment request on every seek and every ABR switch.
    // Before this fix, out.destroy() only triggered an unpipe() on `rest`
    // (a manual rest.pipe(out)) that PAUSED it without destroying it: the fd —
    // and its 64 KB buffer — stayed open forever. Measured then on a real
    // segment: after out.destroy(), rest.destroyed=false, rest.closed=false,
    // with the fd still open.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-abort-'))
    const abortOutDir = join(dir, 'out'); mkdirSync(abortOutDir)
    const segments = session['segments']
    const s = new TranscodeSession({
      input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 1, outDir: abortOutDir,
    })
    s.start(0)
    const spy = vi.mocked(createReadStream)
    const callsBefore = spy.mock.calls.length

    const out = await s.openSegment(0, 0, 30_000)
    // The mdat stream is the last createReadStream call openSegment made (the
    // only one with `start: headLen`; the no-timescales fallback does not apply
    // here because requestInit already populated `timescales`).
    expect(spy.mock.calls.length).toBeGreaterThan(callsBefore)
    const rest = spy.mock.results.at(-1)!.value as ReturnType<typeof createReadStream>
    expect(rest.destroyed).toBe(false)

    out.destroy(new Error('client abort'))
    await new Promise(r => setTimeout(r, 100))

    expect(rest.destroyed).toBe(true)
    await s.stop()
  }, 60_000)

  it('a segment produced by a mid-film start carries the correct absolute timestamp', async () => {
    // If the segment's tfdt does not match what the playlist says, hls.js
    // buffers it in the wrong place: the video does not appear but the
    // subtitles, native <track>s driven by currentTime, keep painting.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-'))
    const tsOutDir = join(dir, 'out'); mkdirSync(tsOutDir)
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264', segments, audioCount: 2, outDir: tsOutDir,
    })
    s.start(mid)
    const seg = await drain(await s.openSegment(0, mid, 30_000))
    const init = readFileSync(await s.requestInit(0, 30_000))

    // openSegment anchors the segment to the boundary the playlist declares, so
    // the margin stops being "almost" and becomes exact up to rounding.
    const [video] = await startTimes(dir, init, seg)
    expect(Math.abs(video - segments[mid].start)).toBeLessThan(0.05)
    await s.stop()
  }, 90_000)

  it('openSegment on an audio-only variant (audioCount:2) also anchors to the right instant', async () => {
    // The three measurements above only go through variant 0. With audioCount:2
    // there are variants 1..N, one per audio track — each with its own init and
    // its own timescales (requestInit/canonicalizeInit) — and that path had no
    // measurement at all. A failure there would be silent: if the track_id did
    // not line up between this variant's init and its segment's tfhd,
    // retimeHeader does not throw — it skips the track
    // (`if (timescale === undefined) continue`) — and serves the segment with
    // its original tfdt, resurrecting the bug in multi-audio rooms only.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-audio-'))
    const audioOutDir = join(dir, 'out'); mkdirSync(audioOutDir)
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264', segments, audioCount: 2, outDir: audioOutDir,
    })
    s.start(mid)
    const seg = await drain(await s.openSegment(1, mid, 30_000))
    const init = readFileSync(await s.requestInit(1, 30_000))

    const times = await startTimes(dir, init, seg)
    expect(times).toHaveLength(1) // v1 is audio only: one track, not two
    expect(Math.abs(times[0] - segments[mid].start)).toBeLessThan(0.05)
    await s.stop()
  }, 90_000)

  it('a segment produced by a mid-film start in TRANSCODE mode carries the correct absolute timestamp', async () => {
    // Same measurement, transcode mode: -ss must be seg.start (the boundary),
    // not seg.seekAt (the copy-mode keyframe midpoint), or the first output
    // frame lands half a GOP late — invisible in copy mode because ffmpeg
    // there can't discard frames, but a real regression in transcode mode
    // where it decodes and discards up to whatever instant -ss names.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-transcode-'))
    const tsOutDir = join(dir, 'out'); mkdirSync(tsOutDir)
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const s = new TranscodeSession({
      input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 2, outDir: tsOutDir,
    })
    s.start(mid)
    const seg = await drain(await s.openSegment(0, mid, 30_000))
    const init = readFileSync(await s.requestInit(0, 30_000))

    // openSegment anchors the segment to the boundary the playlist declares, so
    // the margin stops being "almost" and becomes exact up to rounding.
    const [video] = await startTimes(dir, init, seg)
    expect(Math.abs(video - segments[mid].start)).toBeLessThan(0.05)
    await s.stop()
  }, 90_000)

  it('a mid-film restart in transcode mode cuts the segment at the planned 4s boundary, not x264\'s default keyint', async () => {
    // `t` in -force_key_frames is relative to the -ss point, even with -copyts:
    // if the expression stays anchored to seg.start it is never satisfied, x264
    // falls back to its default keyint (~10 s at 24 fps) and the segment
    // produced overruns what the playlist (planSegments, 4 s target) says.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-kf-'))
    const kfOutDir = join(dir, 'out'); mkdirSync(kfOutDir)
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const s = new TranscodeSession({
      input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 2, outDir: kfOutDir,
    })
    s.start(mid)
    const segPath = await s.requestSegment(0, mid, 60_000)
    const initPath = await s.requestInit(0, 30_000)

    const joined = join(dir, 'joined.mp4')
    writeFileSync(joined, Buffer.concat([readFileSync(initPath), readFileSync(segPath)]))
    const { stdout } = await run(ffprobeStatic.path, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'format=duration', '-of', 'csv=p=0', joined,
    ])

    expect(Math.abs(Number(stdout.trim()) - segments[mid].duration)).toBeLessThan(1.5)
    await s.stop()
  }, 90_000)
})
