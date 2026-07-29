import { join } from 'node:path'
import type { Segment } from './planner.js'

export interface TranscodeArgsInput {
  input: string; mode: 'copy' | 'transcode'; encoder: string
  startSegment: number; segments: Segment[]; audioCount: number; outDir: string
}

const ENCODER_FLAGS: Record<string, string[]> = {
  libx264: ['-preset', 'veryfast', '-crf', '21'],
  h264_videotoolbox: ['-b:v', '6M'],
  h264_nvenc: ['-preset', 'p4', '-cq', '23'],
  h264_qsv: ['-global_quality', '23'],
}

export function buildTranscodeArgs(x: TranscodeArgsInput): string[] {
  const seg = x.segments[x.startSegment]
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y']
  if (seg.start > 0) args.push('-ss', seg.start.toFixed(6))
  args.push('-i', x.input, '-map', '0:v:0')
  if (x.mode === 'copy') args.push('-c:v', 'copy')
  else args.push('-c:v', x.encoder, ...(ENCODER_FLAGS[x.encoder] ?? []),
    '-force_key_frames', 'expr:gte(t,n_forced*4)', '-pix_fmt', 'yuv420p')
  for (let i = 0; i < x.audioCount; i++) args.push('-map', `0:a:${i}`)
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '128k')
  const vsm = ['v:0,agroup:aud', ...Array.from({ length: x.audioCount }, (_, i) => `a:${i},agroup:aud`)].join(' ')
  // -ss antes de -i resetea los timestamps de salida a ~0: sin este offset, un
  // reinicio a mitad de película (seek) produce segmentos cuyo tfdt contradice
  // la playlist, hls.js los bufferiza en la posición 0 y el vídeo se queda
  // cargando. Con el offset, el tfdt vuelve a coincidir con la línea de tiempo.
  if (seg.start > 0) args.push('-output_ts_offset', seg.start.toFixed(6))
  args.push(
    '-f', 'hls', '-hls_time', '4', '-hls_segment_type', 'fmp4',
    '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments+temp_file',
    '-start_number', String(x.startSegment),
    '-hls_segment_filename', join(x.outDir, 'seg_%v_%05d.m4s'),
    '-hls_fmp4_init_filename', 'init_%v.mp4',
    '-var_stream_map', vsm,
    join(x.outDir, 'ffm_%v.m3u8'),
  )
  return args
}
