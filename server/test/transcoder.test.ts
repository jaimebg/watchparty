import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureMkv } from './support/fixture.js'
import { extractKeyframes, probeFile } from '../src/media/probe.js'
import { planSegments } from '../src/media/planner.js'
import { TranscodeSession } from '../src/media/transcoder.js'

let fixture: string, session: TranscodeSession, outDir: string

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
})
