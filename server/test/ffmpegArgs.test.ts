import { describe, it, expect } from 'vitest'
import { buildTranscodeArgs, toFfmpegPath } from '../src/media/ffmpegArgs.js'
import { planSegments } from '../src/media/planner.js'

const base = { input: '/x/in.mkv', encoder: 'libx264', segments: planSegments(20, null), audioCount: 2, outDir: '/tmp/out' }

describe('toFfmpegPath', () => {
  it('turns Windows backslashes into the slashes ffmpeg understands', () => {
    expect(toFfmpegPath('C:\\Users\\x\\out\\ffm_0.m3u8')).toBe('C:/Users/x/out/ffm_0.m3u8')
  })

  it('leaves a path that already uses forward slashes untouched', () => {
    expect(toFfmpegPath('/tmp/out/ffm_0.m3u8')).toBe('/tmp/out/ffm_0.m3u8')
  })
})

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
      expect(i).toBeGreaterThan(a.indexOf('-i')) // an output option: after the input
      expect(i).toBeLessThan(a.length - 1) // and before the output URL
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
  // The HLS muxer splits an audio-only variant at exactly every -hls_time, while
  // the video one is split at keyframes: with a single track there is no reason
  // to separate them, and keeping them together makes it impossible for their
  // boundaries to drift. Measured with this ffmpeg: when -var_stream_map declares
  // a single variant, -hls_fmp4_init_filename leaves the "%v" unsubstituted and
  // the init ends up in a file literally named "init_%v.mp4", which requestInit()
  // never finds. With a single variant the numbering is done by hand and the map
  // is not needed.
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
  // Measured with this ffmpeg: it works out the directory to leave the init in by
  // looking for the last "/" in the playlist path, and the "\" that join()
  // produces on Windows will not do. With no slash to find it ends up with no
  // directory and writes init_0.mp4 into the process's CWD, where requestInit()
  // does not look: on Windows no room ever managed to serve video. The segments
  // survived because -hls_segment_filename is used verbatim.
  it('emits output paths with forward slashes, which is what ffmpeg can read', () => {
    const a = buildTranscodeArgs({ ...base, audioCount: 1, outDir: 'C:\\Users\\x\\out', mode: 'copy', startSegment: 0 })
    const salidas = a.filter(v => v.includes('ffm_0.m3u8') || v.includes('seg_0_'))
    expect(salidas).toHaveLength(2)
    for (const s of salidas) expect(s).not.toContain('\\')
    expect(a).toContain('C:/Users/x/out/ffm_0.m3u8')
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
