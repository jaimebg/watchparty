import { describe, it, expect } from 'vitest'
import { planSegments, segmentForTime, buildMasterPlaylist, buildMediaPlaylist } from '../src/media/planner.js'

describe('planSegments', () => {
  it('uniform 4s cuts without keyframes', () => {
    const segs = planSegments(10, null)
    expect(segs.map(s => [s.start, s.duration])).toEqual([[0, 4], [4, 4], [8, 2]])
  })
  it('keyframe-aligned cuts (first kf >= 4s from previous cut)', () => {
    const segs = planSegments(12, [0, 2, 4.5, 6, 9.1, 11])
    expect(segs.map(s => s.start)).toEqual([0, 4.5, 9.1])
    expect(segs.at(-1)!.duration).toBeCloseTo(2.9)
  })
  it('aims the seek at the midpoint to the next keyframe, not at the boundary itself', () => {
    // Matroska would back up a GOP if -ss landed exactly on the keyframe.
    const segs = planSegments(12, [0, 2, 4.5, 6, 9.1, 11])
    expect(segs.map(s => s.start)).toEqual([0, 4.5, 9.1])
    expect(segs.map(s => s.seekAt)).toEqual([0, 5.25, 10.05]) // (4.5+6)/2, (9.1+11)/2
  })
  it('falls back to the segment start when there is no keyframe list (transcode mode seeks exactly)', () => {
    expect(planSegments(10, null).map(s => s.seekAt)).toEqual([0, 4, 8])
  })
  it('uses the file end as the next boundary for a last segment with no later keyframe', () => {
    const segs = planSegments(10, [0, 5])
    expect(segs.at(-1)!.seekAt).toBeCloseTo(7.5) // (5 + 10) / 2
  })
})

describe('segmentForTime', () => {
  it('maps times to segment index', () => {
    const segs = planSegments(10, null)
    expect(segmentForTime(segs, 0)).toBe(0)
    expect(segmentForTime(segs, 4.1)).toBe(1)
    expect(segmentForTime(segs, 9.9)).toBe(2)
  })
})

describe('playlists', () => {
  const audio = [
    { index: 0, codec: 'aac', lang: 'spa', label: 'Español', channels: 2 },
    { index: 1, codec: 'aac', lang: 'eng', label: 'English', channels: 2 },
  ]
  it('master lists audio renditions and one variant', () => {
    const m = buildMasterPlaylist(audio)
    expect(m).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Español",LANGUAGE="spa",DEFAULT=YES,AUTOSELECT=YES,URI="audio_1.m3u8"')
    expect(m).toContain('URI="audio_2.m3u8"')
    expect(m).toContain('AUDIO="aud"')
    expect(m.trim().endsWith('video.m3u8')).toBe(true)
  })
  // With a single track the audio rides inside the video variant itself (see
  // hlsLayout.ts), so there is no alternate rendition to announce: leaving the
  // "aud" group in the master would send hls.js after an audio_1.m3u8 that
  // neither exists nor would share the video's boundaries.
  it('master has no alternate-audio group when there is a single track', () => {
    const m = buildMasterPlaylist([audio[0]])
    expect(m).not.toContain('#EXT-X-MEDIA')
    expect(m).not.toContain('AUDIO="aud"')
    expect(m).toContain('#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="avc1.64001f,mp4a.40.2"')
    expect(m.trim().endsWith('video.m3u8')).toBe(true)
  })
  it('master has no alternate-audio group when there is no audio at all', () => {
    const m = buildMasterPlaylist([])
    expect(m).not.toContain('#EXT-X-MEDIA')
    expect(m.trim().endsWith('video.m3u8')).toBe(true)
  })
  it('escapes double quotes in NAME/LANGUAGE so a source-provided label cannot break the attribute list', () => {
    // Two tracks: the only case with an #EXT-X-MEDIA to escape (with one, the
    // audio rides inside the video variant and there are no attributes to break).
    const quoted = [
      { index: 0, codec: 'aac', lang: 'spa "Latino"', label: 'The "Director" commentary', channels: 2 },
      { index: 1, codec: 'aac', lang: 'eng', label: 'English', channels: 2 },
    ]
    const m = buildMasterPlaylist(quoted)
    expect(m).toContain('NAME="The \'Director\' commentary"')
    expect(m).toContain('LANGUAGE="spa \'Latino\'"')
    // GROUP-ID, NAME, LANGUAGE and URI are each a quoted attribute (4 pairs =
    // 8 delimiters); any extra `"` would mean an unescaped quote leaked in.
    const mediaLine = m.split('\n').find(l => l.startsWith('#EXT-X-MEDIA'))!
    expect(mediaLine.match(/"/g)?.length).toBe(8)
  })
  it('media playlist is a full VOD with map and endlist', () => {
    const p = buildMediaPlaylist(planSegments(10, null), 0)
    expect(p).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(p).toContain('#EXT-X-MAP:URI="init_0.mp4"')
    expect(p).toContain('seg_0_00000.m4s')
    expect(p).toContain('seg_0_00002.m4s')
    expect(p).toContain('#EXTINF:2.000000,')
    expect(p.trim().endsWith('#EXT-X-ENDLIST')).toBe(true)
  })
})
