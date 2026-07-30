import { describe, it, expect } from 'vitest'
import { streamUrl } from '../src/player/streamUrl'

describe('streamUrl', () => {
  it('sin base usa el mismo origen (comportamiento en LAN y sin relevo)', () => {
    expect(streamUrl('', 'tok', 'master.m3u8')).toBe('/stream/tok/master.m3u8')
  })

  // El servidor manda '' cuando no hay relevo, pero el tipo permite null/undefined
  // (config sin el campo, respuesta de una versión vieja): ninguno debe acabar
  // como el literal 'null' dentro de la URL.
  it('trata null y undefined como mismo origen', () => {
    expect(streamUrl(null, 'tok', 'video.m3u8')).toBe('/stream/tok/video.m3u8')
    expect(streamUrl(undefined, 'tok', 'video.m3u8')).toBe('/stream/tok/video.m3u8')
  })

  it('antepone el origen del relevo', () => {
    expect(streamUrl('https://stream.example.com', 'tok', 'master.m3u8'))
      .toBe('https://stream.example.com/stream/tok/master.m3u8')
  })

  it('no duplica la barra cuando la base ya la trae', () => {
    expect(streamUrl('https://stream.example.com/', 'tok', 'init_0.mp4'))
      .toBe('https://stream.example.com/stream/tok/init_0.mp4')
    expect(streamUrl('https://stream.example.com///', 'tok', 'init_0.mp4'))
      .toBe('https://stream.example.com/stream/tok/init_0.mp4')
  })

  it('conserva el prefijo de ruta de una base con subdirectorio', () => {
    expect(streamUrl('https://example.com/relay', 'tok', 'sub_0.vtt'))
      .toBe('https://example.com/relay/stream/tok/sub_0.vtt')
  })

  // Lo que hace que el resto de la playlist siga al mismo host sin tocar el
  // servidor: los nombres relativos que emite planner.ts se resuelven contra la
  // URL del master, así que basta con que ESTA apunte al relevo.
  it('el master queda en un directorio del que cuelgan los nombres relativos', () => {
    const master = streamUrl('https://stream.example.com', 'tok', 'master.m3u8')
    expect(new URL('seg_0_00001.m4s', master).href)
      .toBe('https://stream.example.com/stream/tok/seg_0_00001.m4s')
  })
})
