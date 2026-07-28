import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureMkv } from './support/fixture.js'
import { probeFile, extractKeyframes } from '../src/media/probe.js'

let fixture: string
beforeAll(async () => { fixture = await makeFixtureMkv(mkdtempSync(join(tmpdir(), 'probe-'))) })

describe('probeFile', () => {
  it('reads duration, video codec and track lists', async () => {
    const info = await probeFile(fixture)
    expect(info.durationSec).toBeGreaterThan(9)
    expect(info.videoCodec).toBe('h264')
    expect(info.audio).toHaveLength(2)
    expect(info.audio[0]).toMatchObject({ index: 0, lang: 'spa', channels: 1 })
    expect(info.audio[1].lang).toBe('eng')
    expect(info.subs).toHaveLength(1)
    expect(info.subs[0].textBased).toBe(true)
  })
})

describe('extractKeyframes', () => {
  it('returns sorted keyframe times starting near 0', async () => {
    const kf = await extractKeyframes(fixture)
    expect(kf.length).toBeGreaterThanOrEqual(4)
    expect(kf[0]).toBeLessThan(0.5)
    expect([...kf].sort((a, b) => a - b)).toEqual(kf)
  })
})
