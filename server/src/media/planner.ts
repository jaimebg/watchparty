import type { AudioTrack } from './probe.js'
import { langLabel } from './lang.js'

export interface Segment { index: number; start: number; duration: number }

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
  audio.forEach((a, i) => lines.push(
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${escapeAttr(langLabel(a.lang) ?? a.label)}",LANGUAGE="${escapeAttr(a.lang)}",DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,URI="audio_${a.index + 1}.m3u8"`))
  lines.push('#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"', 'video.m3u8')
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
