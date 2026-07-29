import { describe, it, expect } from 'vitest'
import { buildTranscodeArgs } from '../src/media/ffmpegArgs.js'
import { planSegments } from '../src/media/planner.js'

const base = { input: '/x/in.mkv', encoder: 'libx264', segments: planSegments(20, null), audioCount: 2, outDir: '/tmp/out' }

describe('buildTranscodeArgs', () => {
  it('copy mode from segment 0: no -ss, -c:v copy, audio renditions, var_stream_map', () => {
    const a = buildTranscodeArgs({ ...base, mode: 'copy', startSegment: 0 })
    expect(a).not.toContain('-ss')
    expect(a.join(' ')).toContain('-c:v copy')
    expect(a.join(' ')).toContain('-var_stream_map v:0,agroup:aud a:0,agroup:aud a:1,agroup:aud')
    expect(a.join(' ')).toContain('-start_number 0')
    expect(a.join(' ')).toContain('seg_%v_%05d.m4s')
  })
  it('restart mid-stream offsets output timestamps to the segment start', () => {
    for (const mode of ['copy', 'transcode'] as const) {
      const a = buildTranscodeArgs({ ...base, mode, startSegment: 2 })
      const i = a.indexOf('-output_ts_offset')
      expect(i).toBeGreaterThan(a.indexOf('-i')) // opción de salida: tras el input
      expect(i).toBeLessThan(a.length - 1) // y antes de la URL de salida
      expect(Number(a[i + 1])).toBeCloseTo(8)
    }
  })
  it('start from segment 0 needs no timestamp offset', () => {
    const a = buildTranscodeArgs({ ...base, mode: 'copy', startSegment: 0 })
    expect(a).not.toContain('-output_ts_offset')
  })
  it('transcode mode seeks to segment start and forces keyframes', () => {
    const a = buildTranscodeArgs({ ...base, mode: 'transcode', startSegment: 2 })
    const i = a.indexOf('-ss')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(Number(a[i + 1])).toBeCloseTo(8)
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'))
    expect(a.join(' ')).toContain('-force_key_frames expr:gte(t,n_forced*4)')
    expect(a.join(' ')).toContain('-start_number 2')
  })
})
