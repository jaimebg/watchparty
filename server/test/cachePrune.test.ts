import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickPrunable, segmentFilesWithStats } from '../src/media/cachePrune.js'

const f = (path: string, mtimeMs: number, size: number) => ({ path, mtimeMs, size })

describe('pickPrunable', () => {
  it('returns nothing under the limit', () => {
    expect(pickPrunable([f('a', 1, 100), f('b', 2, 100)], 500)).toEqual([])
  })
  it('drops oldest files until under limit', () => {
    expect(pickPrunable([f('new', 3, 100), f('old', 1, 100), f('mid', 2, 100)], 150)).toEqual(['old', 'mid'])
  })
})

describe('segmentFilesWithStats', () => {
  it('returns [] for a nonexistent dir', () => {
    expect(segmentFilesWithStats(join(tmpdir(), 'does-not-exist-' + Date.now()))).toEqual([])
  })

  it('lists only .m4s files in a dir with stats', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seg-'))
    writeFileSync(join(dir, 'seg_0_00000.m4s'), 'abc')
    writeFileSync(join(dir, 'init_0.mp4'), 'xyz')
    const files = segmentFilesWithStats(dir)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe(join(dir, 'seg_0_00000.m4s'))
    expect(files[0].size).toBe(3)
    expect(typeof files[0].mtimeMs).toBe('number')
  })
})
