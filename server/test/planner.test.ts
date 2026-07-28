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
