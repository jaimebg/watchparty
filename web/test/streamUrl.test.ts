import { describe, it, expect } from 'vitest'
import { streamUrl } from '../src/player/streamUrl'

describe('streamUrl', () => {
  it('sin base usa el mismo origen (comportamiento en LAN y sin relevo)', () => {
    expect(streamUrl('', 'tok', 1, 'master.m3u8')).toBe('/stream/tok/e1/master.m3u8')
  })

  // El servidor manda '' cuando no hay relevo, pero el tipo permite null/undefined
  // (config sin el campo, respuesta de una versión vieja): ninguno debe acabar
  // como el literal 'null' dentro de la URL.
  it('trata null y undefined como mismo origen', () => {
    expect(streamUrl(null, 'tok', 1, 'video.m3u8')).toBe('/stream/tok/e1/video.m3u8')
    expect(streamUrl(undefined, 'tok', 1, 'video.m3u8')).toBe('/stream/tok/e1/video.m3u8')
  })

  it('antepone el origen del relevo', () => {
    expect(streamUrl('https://stream.example.com', 'tok', 3, 'master.m3u8'))
      .toBe('https://stream.example.com/stream/tok/e3/master.m3u8')
  })

  it('no duplica la barra cuando la base ya la trae', () => {
    expect(streamUrl('https://stream.example.com/', 'tok', 1, 'init_0.mp4'))
      .toBe('https://stream.example.com/stream/tok/e1/init_0.mp4')
    expect(streamUrl('https://stream.example.com///', 'tok', 1, 'init_0.mp4'))
      .toBe('https://stream.example.com/stream/tok/e1/init_0.mp4')
  })

  it('conserva el prefijo de ruta de una base con subdirectorio', () => {
    expect(streamUrl('https://example.com/relay', 'tok', 2, 'sub_0.vtt'))
      .toBe('https://example.com/relay/stream/tok/e2/sub_0.vtt')
  })

  // Lo que hace que el resto de la playlist siga al mismo host sin tocar el
  // servidor: los nombres relativos que emite planner.ts se resuelven contra la
  // URL del master, así que basta con que ESTA apunte al relevo.
  it('el master queda en un directorio del que cuelgan los nombres relativos', () => {
    const master = streamUrl('https://stream.example.com', 'tok', 1, 'master.m3u8')
    expect(new URL('seg_0_00001.m4s', master).href)
      .toBe('https://stream.example.com/stream/tok/e1/seg_0_00001.m4s')
  })

  // La razón de meter el epoch en el PATH y no en una query: los nombres
  // relativos de la playlist caen dentro de e<n>/ solos, así que planner.ts
  // puede seguir sin saber que el epoch existe.
  it('los nombres relativos caen dentro del epoch del master', () => {
    const master = streamUrl('', 'tok', 7, 'master.m3u8')
    expect(new URL('video.m3u8', `https://app.example.com${master}`).pathname)
      .toBe('/stream/tok/e7/video.m3u8')
    expect(new URL('init_0.mp4', `https://app.example.com${master}`).pathname)
      .toBe('/stream/tok/e7/init_0.mp4')
  })

  // Dos generaciones de la misma sala NO comparten URL: es lo que impide que la
  // caché del navegador (o la del relevo) sirva los bytes de la película
  // anterior, porque init_0.mp4 y seg_0_00000.m4s se llaman igual en las dos.
  it('dos epochs de la misma sala no comparten URL', () => {
    expect(streamUrl('', 'tok', 1, 'seg_0_00000.m4s'))
      .not.toBe(streamUrl('', 'tok', 2, 'seg_0_00000.m4s'))
  })
})
