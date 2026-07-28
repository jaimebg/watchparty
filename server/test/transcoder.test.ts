import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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

  it('seek restart produces the requested later segment', async () => {
    const last = session['segments'].length - 1
    const p = await session.requestSegment(0, last, 45_000)
    expect(existsSync(p)).toBe(true)
  })
})
