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
  it('restart mid-stream keeps the source timeline with -copyts', () => {
    for (const mode of ['copy', 'transcode'] as const) {
      const a = buildTranscodeArgs({ ...base, mode, startSegment: 2 })
      const i = a.indexOf('-copyts')
      expect(i).toBeGreaterThan(a.indexOf('-i')) // opción de salida: tras el input
      expect(i).toBeLessThan(a.length - 1) // y antes de la URL de salida
      expect(a).not.toContain('-output_ts_offset')
    }
  })
  it('start from segment 0 needs no timestamp offset', () => {
    const a = buildTranscodeArgs({ ...base, mode: 'copy', startSegment: 0 })
    expect(a).not.toContain('-copyts')
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
  it('seeks to the midpoint, not to the boundary, when real keyframes are known', () => {
    const segments = planSegments(20, [0, 2, 4, 6, 8, 10, 12])
    const a = buildTranscodeArgs({ ...base, segments, mode: 'copy', startSegment: 1 })
    expect(segments[1].start).toBe(4)
    expect(Number(a[a.indexOf('-ss') + 1])).toBeCloseTo(5) // (4 + 6) / 2
  })
  // Una variante de solo-audio la parte el muxer HLS cada -hls_time exacto,
  // mientras que la de vídeo se parte en keyframes: con una sola pista no hay
  // razón para separarlas, y juntarlas hace imposible que sus límites deriven.
  // Medido con este ffmpeg: si -var_stream_map declara una sola variante,
  // -hls_fmp4_init_filename deja el «%v» sin sustituir y el init acaba en un
  // archivo llamado literalmente «init_%v.mp4», que requestInit() jamás
  // encuentra. Con una sola variante se numera a mano y no hace falta el mapa.
  it('muxes video and audio into a single, hand-numbered variant when there is at most one audio track', () => {
    const a = buildTranscodeArgs({ ...base, audioCount: 1, mode: 'copy', startSegment: 0 })
    expect(a).not.toContain('-var_stream_map')
    expect(a.join(' ')).not.toContain('%v')
    expect(a.join(' ')).toContain('seg_0_%05d.m4s')
    expect(a.join(' ')).toContain('-hls_fmp4_init_filename init_0.mp4')
    expect(a.join(' ')).toContain('-map 0:a:0')
    expect(a.join(' ')).toContain('-c:a aac')
  })
  it('maps no audio and asks for no audio encoder when the source has none', () => {
    const a = buildTranscodeArgs({ ...base, audioCount: 0, mode: 'copy', startSegment: 0 })
    expect(a.join(' ')).not.toContain('-map 0:a')
    expect(a).not.toContain('-c:a')
    expect(a.join(' ')).toContain('seg_0_%05d.m4s')
  })
  it('transcode mode seeks to the boundary, not the midpoint, even when real keyframes are known', () => {
    // Transcode decodes and discards up to the requested instant, so -ss must
    // land on seg.start; feeding it seg.seekAt (the copy-mode midpoint) would
    // start the output half a GOP late. base's planSegments(20, null) can't
    // exercise this because there seekAt === start, so the divergence would be
    // invisible — this needs a real keyframe list, like planner.ts's own test.
    const segments = planSegments(20, [0, 2, 4, 6, 8, 10, 12])
    const a = buildTranscodeArgs({ ...base, segments, mode: 'transcode', startSegment: 1 })
    expect(segments[1].start).toBe(4)
    expect(segments[1].seekAt).toBeCloseTo(5) // (4 + 6) / 2 — must NOT be what -ss gets
    expect(Number(a[a.indexOf('-ss') + 1])).toBeCloseTo(segments[1].start)
  })
})
