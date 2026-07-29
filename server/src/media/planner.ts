import type { AudioTrack } from './probe.js'
import { langLabel } from './lang.js'
import { variantCount } from './hlsLayout.js'

export interface Segment { index: number; start: number; duration: number; seekAt: number }

// El demuxer de Matroska retrocede al keyframe ANTERIOR cuando el -ss cae justo
// sobre uno (ffmpeg se guarda un margen de ~0,17 s), y aquí todos los límites
// salen de la lista real de keyframes: sin esto, cada reinicio a mitad de
// película en un MKV empieza un GOP antes de lo que declara la playlist y hls.js
// bufferiza el segmento en el sitio equivocado. Apuntar al punto medio hasta el
// siguiente keyframe acierta sin depender de adivinar ese margen; un epsilon
// pequeño y fijo no basta (medido: +0,05 s sigue cayendo un GOP antes).
// Lo que decide si hace falta este punto medio es el MODO, no si hay lista de
// keyframes: en copy no se puede descartar fotogramas, así que el seek tiene
// que apuntar más allá del keyframe. En transcode ffmpeg decodifica y descarta
// hasta el instante pedido, así que debe apuntar al límite mismo (seg.start) —
// buildTranscodeArgs es quien elige entre seekAt y start según el modo; esta
// función solo calcula el valor por si hace falta.
function seekPoint(start: number, keyframes: number[] | null, durationSec: number): number {
  if (start === 0 || !keyframes || keyframes.length === 0) return start
  const next = keyframes.find(k => k > start) ?? durationSec
  return next > start ? (start + next) / 2 : start
}

export function planSegments(durationSec: number, keyframes: number[] | null, target = 4): Segment[] {
  const bounds: number[] = [0]
  if (keyframes && keyframes.length > 0) {
    let last = 0
    for (const k of keyframes) if (k - last >= target && k < durationSec) { bounds.push(k); last = k }
  } else {
    for (let t = target; t < durationSec; t += target) bounds.push(t)
  }
  return bounds.map((start, i) => ({
    index: i, start,
    duration: (i + 1 < bounds.length ? bounds[i + 1] : durationSec) - start,
    seekAt: seekPoint(start, keyframes, durationSec),
  }))
}

export function segmentForTime(segments: Segment[], t: number): number {
  for (let i = segments.length - 1; i >= 0; i--) if (segments[i].start <= t) return i
  return 0
}

// HLS attribute-lists use double quotes as the string delimiter with no
// escape sequence, so a `"` inside a source-provided label/language would
// otherwise break the #EXT-X-MEDIA line's syntax. Swap for a single quote.
const escapeAttr = (s: string): string => s.replace(/"/g, "'")

export function buildMasterPlaylist(audio: AudioTrack[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7']
  // Con 0 o 1 pista el audio viaja dentro del propio variant de vídeo
  // (hlsLayout.ts), así que no hay rendición alternativa que anunciar:
  // anunciarla mandaría a hls.js a por un audio_1.m3u8 inexistente.
  const alternate = variantCount(audio.length) > 1
  if (alternate) {
    audio.forEach((a, i) => lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${escapeAttr(langLabel(a.lang) ?? a.label)}",LANGUAGE="${escapeAttr(a.lang)}",DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,URI="audio_${a.index + 1}.m3u8"`))
  }
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="avc1.64001f,mp4a.40.2"${alternate ? ',AUDIO="aud"' : ''}`, 'video.m3u8')
  return lines.join('\n') + '\n'
}

export function buildMediaPlaylist(segments: Segment[], variant: number): string {
  const target = Math.ceil(Math.max(...segments.map(s => s.duration)))
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-MAP:URI="init_${variant}.mp4"`]
  for (const s of segments) {
    lines.push(`#EXTINF:${s.duration.toFixed(6)},`)
    lines.push(`seg_${variant}_${String(s.index).padStart(5, '0')}.m4s`)
  }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n') + '\n'
}
