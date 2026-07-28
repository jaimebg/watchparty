import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureMkv } from './support/fixture.js'
import { probeFile } from '../src/media/probe.js'
import { listSubtitleOptions, extractSubtitle } from '../src/media/subtitles.js'

let dir: string, fixture: string, info: Awaited<ReturnType<typeof probeFile>>, extSrt: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'subs-'))
  fixture = await makeFixtureMkv(dir)
  info = await probeFile(fixture)
  extSrt = join(dir, 'fixture.es.srt')
  writeFileSync(extSrt, '1\n00:00:00,500 --> 00:00:02,000\nExterno\n')
})

describe('subtitles', () => {
  it('lists embedded text subs then external srt', () => {
    const opts = listSubtitleOptions(info, [extSrt])
    expect(opts).toHaveLength(2)
    expect(opts[0].id).toBe(0)
    expect(opts[1].label).toBe('fixture.es')
  })
  it('extracts embedded track to vtt', async () => {
    const out = join(dir, 'emb.vtt')
    await extractSubtitle(fixture, info, [extSrt], 0, out)
    expect(readFileSync(out, 'utf8')).toContain('WEBVTT')
    expect(readFileSync(out, 'utf8')).toContain('Hola fixture')
  })
  it('converts external srt to vtt', async () => {
    const out = join(dir, 'ext.vtt')
    await extractSubtitle(fixture, info, [extSrt], 1, out)
    expect(readFileSync(out, 'utf8')).toContain('Externo')
  })
})
