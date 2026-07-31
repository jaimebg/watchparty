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
  h264_nvenc: ['-preset', 'p4', '-cq', '23'],
  h264_qsv: ['-global_quality', '23'],
}

/**
 * Las rutas de salida, con las barras que ffmpeg sabe leer.
 *
 * Hace falta porque ffmpeg resuelve -hls_fmp4_init_filename relativo al
 * directorio del playlist, y ese directorio lo deduce buscando la última «/» de
 * la ruta de salida. Las «\» que produce join() en Windows no le valen: sin
 * barra que encontrar se queda sin directorio base y escribe el init en el CWD
 * del proceso, donde requestInit() no lo busca —así que en Windows ninguna sala
 * llegaba a servir vídeo—. Windows acepta las barras normales en cualquier
 * ruta, y en macOS esto no cambia nada.
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
    // `t` en force_key_frames es relativo al punto de -ss, incluso con
    // -copyts (que solo afecta a los timestamps de salida, no a esta
    // expresión). Anclarlo a seg.start la hace insatisfacible: x264 nunca
    // fuerza un keyframe y cae a su keyint por defecto, produciendo
    // segmentos que no coinciden con lo que dice la playlist.
    '-force_key_frames', 'expr:gte(t,n_forced*4)',
    '-pix_fmt', 'yuv420p')
  for (let i = 0; i < x.audioCount; i++) args.push('-map', `0:a:${i}`)
  if (x.audioCount > 0) args.push('-c:a', 'aac', '-ac', '2', '-b:a', '128k')
  // Re-anclar con -output_ts_offset daba por hecho que ffmpeg caía exactamente
  // donde se le pedía, y en Matroska no es así. -copyts no asume nada: conserva
  // el tiempo absoluto de la fuente, de modo que todos los reinicios comparten
  // una sola línea de tiempo y el tfdt siempre concuerda con la playlist.
  if (seg.start > 0) args.push('-copyts')
  args.push(
    '-f', 'hls', '-hls_time', '4', '-hls_segment_type', 'fmp4',
    '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments+temp_file',
    '-start_number', String(x.startSegment),
  )
  // Una sola variante con el audio dentro, salvo que haya varias pistas entre
  // las que elegir: separar el audio obliga al muxer a partirlo por su cuenta
  // cada -hls_time exacto (ver el contrato completo en hlsLayout.ts).
  //
  // Y con una sola variante hay que numerar a mano: medido con este ffmpeg,
  // -hls_fmp4_init_filename NO sustituye %v si -var_stream_map declara una
  // única variante, así que el init acabaría en un archivo llamado
  // literalmente «init_%v.mp4» y requestInit() esperaría en vano por init_0.mp4.
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
