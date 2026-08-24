import { describe, it, expect } from 'vitest'
import { pickMode, variantCount } from '../src/media/hlsLayout.js'
import type { MediaInfo } from '../src/media/probe.js'

const track = (index: number) => ({ index, codec: 'aac', lang: 'und', label: `Pista ${index}`, channels: 2 })
const info = (patch: Partial<MediaInfo> = {}): MediaInfo => ({
  durationSec: 100, videoCodec: 'h264', pixFmt: 'yuv420p', width: 1920, height: 1080,
  audio: [track(0)], subs: [], ...patch,
})

// The playlist is VOD: where ffmpeg will cut has to be known in advance, and in
// copy mode it cannot be. Measured on a real 2:36 WEBRip: the planner computed
// 1295 cuts and ffmpeg made 2212, so the playlist ran out of video at minute
// 1:26:58 of a 2:36 movie. Transcoding while forcing keyframes every 4 s makes
// the boundaries line up by construction.
describe('pickMode', () => {
  it('transcodes even an h264 8-bit 4:2:0 source with a single audio track', () => {
    expect(pickMode(info())).toBe('transcode')
  })
  it('transcodes what the browser cannot decode as-is', () => {
    expect(pickMode(info({ videoCodec: 'hevc' }))).toBe('transcode')
    expect(pickMode(info({ pixFmt: 'yuv420p10le' }))).toBe('transcode') // Hi10P
  })
  it('transcodes with several audio tracks and with none at all', () => {
    expect(pickMode(info({ audio: [track(0), track(1)] }))).toBe('transcode')
    expect(pickMode(info({ audio: [] }))).toBe('transcode')
  })
})

describe('variantCount', () => {
  // 0 or 1 track => a single variant with video and audio in the SAME segment:
  // that way their boundaries cannot come apart.
  it('muxes video and audio into one variant when there is at most one track', () => {
    expect(variantCount(0)).toBe(1)
    expect(variantCount(1)).toBe(1)
  })
  it('adds one audio-only variant per track when there are several', () => {
    expect(variantCount(2)).toBe(3)
    expect(variantCount(5)).toBe(6)
  })
})
