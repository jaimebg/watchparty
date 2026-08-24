import { join } from 'node:path'
import { variantCount } from './hlsLayout.js'
import type { Segment } from './planner.js'

export interface TranscodeArgsInput {
  input: string; mode: 'copy' | 'transcode'; encoder: string
  startSegment: number; segments: Segment[]; audioCount: number; outDir: string
}

const ENCODER_FLAGS: Record<string, string[]> = {
  libx264: ['-preset', 'veryfast', '-crf', '21'],
  h264_videotoolbox: ['-b:v', '6M'],
  // `-forced-idr 1` is not a quality setting: without it NVENC swallows the
  // -force_key_frames below and falls back to its default GOP (250 frames),
  // breaking hlsLayout.ts's contract — the playlist declares the cuts in advance
  // and ffmpeg has to produce them — without raising any error. Measured with
  // this ffmpeg on a 24 fps source: it cut every 10.417 s instead of every 4 s,
  // and since `openSegment` re-anchors each segment to the instant the playlist
  // already declared, the gap between declared and served grew without bound.
  // It only showed up on Windows with an NVIDIA GPU: the one place where
  // parseEncoders picks this encoder. encoderKeyframes.test.ts guards it.
  h264_nvenc: ['-preset', 'p4', '-cq', '23', '-forced-idr', '1'],
  h264_qsv: ['-global_quality', '23'],
}

/**
 * The output paths, with the slashes ffmpeg knows how to read.
 *
 * Needed because ffmpeg resolves -hls_fmp4_init_filename relative to the
 * playlist's directory, and it works that directory out by looking for the last
 * "/" in the output path. The "\" that join() produces on Windows will not do:
 * with no slash to find it ends up with no base directory and writes the init
 * into the process's CWD, where requestInit() does not look for it — so on
 * Windows no room ever managed to serve video. Windows accepts forward slashes
 * in any path, and on macOS this changes nothing.
 */
export function toFfmpegPath(p: string): string {
  return p.replace(/\\/g, '/')
}

export function buildTranscodeArgs(x: TranscodeArgsInput): string[] {
  const seg = x.segments[x.startSegment]
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y']
  // Copy mode can't discard frames, so the seek has to overshoot past the
  // keyframe (seg.seekAt) to defeat Matroska backing up a GOP. Transcode mode
  // decodes and discards up to the requested instant, so -ss must be aimed at
  // the boundary itself (seg.start); feeding it seekAt there starts the output
  // half a GOP late.
  if (seg.start > 0) args.push('-ss', (x.mode === 'copy' ? seg.seekAt : seg.start).toFixed(6))
  args.push('-i', x.input, '-map', '0:v:0')
  if (x.mode === 'copy') args.push('-c:v', 'copy')
  else args.push('-c:v', x.encoder, ...(ENCODER_FLAGS[x.encoder] ?? []),
    // `t` in force_key_frames is relative to the -ss point, even with -copyts
    // (which only affects output timestamps, not this expression). Anchoring it
    // to seg.start makes it unsatisfiable: x264 never forces a keyframe and
    // falls back to its default keyint, producing segments that do not match
    // what the playlist says.
    '-force_key_frames', 'expr:gte(t,n_forced*4)',
    '-pix_fmt', 'yuv420p')
  for (let i = 0; i < x.audioCount; i++) args.push('-map', `0:a:${i}`)
  if (x.audioCount > 0) args.push('-c:a', 'aac', '-ac', '2', '-b:a', '128k')
  // Re-anchoring with -output_ts_offset assumed ffmpeg landed exactly where it
  // was asked to, and in Matroska it does not. -copyts assumes nothing: it keeps
  // the source's absolute time, so every restart shares a single timeline and
  // the tfdt always agrees with the playlist.
  if (seg.start > 0) args.push('-copyts')
  args.push(
    '-f', 'hls', '-hls_time', '4', '-hls_segment_type', 'fmp4',
    '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments+temp_file',
    '-start_number', String(x.startSegment),
  )
  // A single variant with the audio inside, unless there are several tracks to
  // choose between: splitting the audio out forces the muxer to cut it on its
  // own at exactly every -hls_time (the full contract is in hlsLayout.ts).
  //
  // And with a single variant the numbering has to be done by hand: measured
  // with this ffmpeg, -hls_fmp4_init_filename does NOT substitute %v when
  // -var_stream_map declares a single variant, so the init would end up in a
  // file literally named "init_%v.mp4" and requestInit() would wait forever on
  // init_0.mp4.
  if (variantCount(x.audioCount) === 1) {
    args.push(
      '-hls_segment_filename', toFfmpegPath(join(x.outDir, 'seg_0_%05d.m4s')),
      '-hls_fmp4_init_filename', 'init_0.mp4',
      toFfmpegPath(join(x.outDir, 'ffm_0.m3u8')),
    )
  } else {
    args.push(
      '-hls_segment_filename', toFfmpegPath(join(x.outDir, 'seg_%v_%05d.m4s')),
      '-hls_fmp4_init_filename', 'init_%v.mp4',
      '-var_stream_map', ['v:0,agroup:aud', ...Array.from({ length: x.audioCount }, (_, i) => `a:${i},agroup:aud`)].join(' '),
      toFfmpegPath(join(x.outDir, 'ffm_%v.m3u8')),
    )
  }
  return args
}
