import { describe, it, expect } from 'vitest'
import { pickMode, variantCount } from '../src/media/hlsLayout.js'
import type { MediaInfo } from '../src/media/probe.js'

const track = (index: number) => ({ index, codec: 'aac', lang: 'und', label: `Pista ${index}`, channels: 2 })
const info = (patch: Partial<MediaInfo> = {}): MediaInfo => ({
  durationSec: 100, videoCodec: 'h264', pixFmt: 'yuv420p', width: 1920, height: 1080,
  audio: [track(0)], subs: [], ...patch,
})

// La playlist es VOD: hay que saber de antemano dónde cortará ffmpeg, y en modo
// copy eso no se puede saber. Medido en un WEBRip real de 2:36: el planner
// calculaba 1295 cortes y ffmpeg hizo 2212, de modo que la playlist se quedaba
// sin vídeo en el minuto 1:26:58 de una película de 2:36. Transcodificar
// forzando keyframes cada 4 s hace que los límites coincidan por construcción.
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
  // 0 o 1 pista => un único variant con vídeo y audio en el MISMO segmento:
  // así es imposible que sus límites se separen.
  it('muxes video and audio into one variant when there is at most one track', () => {
    expect(variantCount(0)).toBe(1)
    expect(variantCount(1)).toBe(1)
  })
  it('adds one audio-only variant per track when there are several', () => {
    expect(variantCount(2)).toBe(3)
    expect(variantCount(5)).toBe(6)
  })
})
