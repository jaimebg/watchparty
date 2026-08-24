import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { makeFixtureMkv } from './support/fixture.js'
import { run } from './support/run.js'
import { buildTranscodeArgs } from '../src/media/ffmpegArgs.js'
import { planSegments } from '../src/media/planner.js'

// The contract this file guards is written out in full in hlsLayout.ts: the
// playlist is VOD, so the server declares the cuts IN ADVANCE from planSegments,
// and `openSegment` re-anchors each segment's header to the instant that
// playlist already declared. None of that is correct if ffmpeg does not cut
// where the plan says, and what decides whether it cuts there is the ENCODER:
// it is the encoder that has to obey -force_key_frames.
//
// And not all of them do. Measured with this ffmpeg on a 24 fps source:
// h264_nvenc ignored -force_key_frames and fell back to its default GOP (250
// frames = 10.427 s), so the playlist declared segment i at 4i while the file
// held what starts at 10.427i — a deviation that grows without bound. libx264
// obeyed. The bug was therefore invisible on macOS (VideoToolbox) and in any
// test that only looked at libx264: it showed up only on Windows with an NVIDIA
// GPU, which is exactly where parseEncoders picks h264_nvenc.
//
// That is why this test does not check flags: it runs the real ffmpeg with the
// production args and measures the cuts that come out, with EVERY encoder that
// works on the machine running the tests. It is the only way the next addition
// (h264_amf, some new qsv, whatever comes) does not repeat the same bug in
// silence.

const FF = ffmpegPath as unknown as string
const FPS = 24
// NVENC's default GOP is 250 frames: at 24 fps, 10.4 s. The source has to last
// well beyond that, or a disobedient encoder would fit in a single segment and
// the deviation would not show. And it must not land exactly on a grid boundary:
// there ffmpeg also closes a residual one-frame segment that is not a bug, just
// the end of the source.
const SECONDS = 22
const SEGMENTS = planSegments(SECONDS, null)

// The candidates are exactly what parseEncoders() can return.
const CANDIDATES = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_videotoolbox']

let dir: string, fixture: string, usable: string[]

// `ffmpeg -encoders` listing an encoder does not prove the machine can use it:
// the bundled binary always lists h264_nvenc and h264_qsv, GPU present or not.
// The only proof is encoding something. An encoder that will not start here is
// skipped (not a failure of this machine); one that starts is measured, and
// there, cutting in the wrong place is a failure.
async function encodes(encoder: string): Promise<boolean> {
  try {
    await run(FF, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${FPS}:duration=1`,
      '-c:v', encoder, '-f', 'null', '-'])
    return true
  } catch {
    return false
  }
}

/**
 * The instants where ffmpeg actually cut, accumulated from the EXTINFs of the
 * playlist it writes itself.
 *
 * The CUTS are measured rather than the durations because it is the cut that has
 * to match the plan: `openSegment` re-anchors each segment to
 * `segments[i].start`, so a cut anywhere else is material served under an
 * instant that is not its own. It also keeps the end of the source from dirtying
 * the measurement: however long the last piece runs, only where it began matters.
 */
function cutPoints(playlist: string): number[] {
  const cuts: number[] = []
  let t = 0
  for (const m of playlist.matchAll(/#EXTINF:([\d.]+)/g)) { t += Number(m[1]); cuts.push(t) }
  return cuts.slice(0, -1) // the last one is not a cut, it is the end of the source
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jbg-enc-'))
  fixture = await makeFixtureMkv(dir, { seconds: SECONDS, withSubs: false, audioTracks: 1 })
  usable = []
  for (const e of CANDIDATES) if (await encodes(e)) usable.push(e)
}, 180_000)

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('the cuts the encoder produces are the ones the playlist declares', () => {
  it('libx264 is always available: without it, the rest of this file would prove nothing', () => {
    expect(usable).toContain('libx264')
  })

  // One `it` per encoder cannot be generated here (the list is discovered in
  // beforeAll, after vitest has collected the tests), so they are walked inside
  // and the failure names the culprit.
  it('every usable encoder cuts on the planSegments grid', async () => {
    // The cuts the server's playlist declares: each segment's start, minus the
    // first, which is not a cut but the origin.
    const expected = SEGMENTS.slice(1).map(s => s.start)
    const failures: string[] = []

    for (const encoder of usable) {
      const outDir = join(dir, `out-${encoder}`)
      mkdirSync(outDir, { recursive: true })
      // The production args verbatim: if buildTranscodeArgs changes, this test
      // finds out. Rebuilding them by hand here would measure something else.
      const args = buildTranscodeArgs({
        input: fixture, mode: 'transcode', encoder,
        startSegment: 0, segments: SEGMENTS, audioCount: 1, outDir,
      })
      await run(FF, args)
      const real = cutPoints(readFileSync(join(outDir, 'ffm_0.m3u8'), 'utf8'))

      const off = expected.find((e, i) => real[i] === undefined || Math.abs(real[i] - e) > 0.2)
      if (off !== undefined) {
        failures.push(`${encoder}: the playlist declares cuts at [${expected.join(', ')}] `
          + `and ffmpeg cut at [${real.map(c => c.toFixed(3)).join(', ')}]`)
      }
    }

    expect(failures, `encoders tested: ${usable.join(', ')}`).toEqual([])
  }, 180_000)
})
