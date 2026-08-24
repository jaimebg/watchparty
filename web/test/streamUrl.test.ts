import { describe, it, expect } from 'vitest'
import { streamUrl } from '../src/player/streamUrl'

describe('streamUrl', () => {
  it('with no base it uses the same origin (LAN behaviour, and with no relay)', () => {
    expect(streamUrl('', 'tok', 1, 'master.m3u8')).toBe('/stream/tok/e1/master.m3u8')
  })

  // The server sends '' when there is no relay, but the type allows
  // null/undefined (a config without the field, a response from an old version):
  // neither may end up as the literal 'null' inside the URL.
  it('treats null and undefined as the same origin', () => {
    expect(streamUrl(null, 'tok', 1, 'video.m3u8')).toBe('/stream/tok/e1/video.m3u8')
    expect(streamUrl(undefined, 'tok', 1, 'video.m3u8')).toBe('/stream/tok/e1/video.m3u8')
  })

  it('prefixes the relay origin', () => {
    expect(streamUrl('https://stream.example.com', 'tok', 3, 'master.m3u8'))
      .toBe('https://stream.example.com/stream/tok/e3/master.m3u8')
  })

  it('does not double the slash when the base already carries one', () => {
    expect(streamUrl('https://stream.example.com/', 'tok', 1, 'init_0.mp4'))
      .toBe('https://stream.example.com/stream/tok/e1/init_0.mp4')
    expect(streamUrl('https://stream.example.com///', 'tok', 1, 'init_0.mp4'))
      .toBe('https://stream.example.com/stream/tok/e1/init_0.mp4')
  })

  it('keeps the path prefix of a base with a subdirectory', () => {
    expect(streamUrl('https://example.com/relay', 'tok', 2, 'sub_0.vtt'))
      .toBe('https://example.com/relay/stream/tok/e2/sub_0.vtt')
  })

  // What makes the rest of the playlist follow the same host without touching
  // the server: the relative names planner.ts emits resolve against the master's
  // URL, so it is enough that THIS one points at the relay.
  it('the master sits in a directory the relative names hang off', () => {
    const master = streamUrl('https://stream.example.com', 'tok', 1, 'master.m3u8')
    expect(new URL('seg_0_00001.m4s', master).href)
      .toBe('https://stream.example.com/stream/tok/e1/seg_0_00001.m4s')
  })

  // The reason for putting the epoch in the PATH and not in a query: the
  // playlist's relative names land inside e<n>/ on their own, so planner.ts can
  // go on not knowing the epoch exists.
  it('the relative names land inside the master\'s epoch', () => {
    const master = streamUrl('', 'tok', 7, 'master.m3u8')
    expect(new URL('video.m3u8', `https://app.example.com${master}`).pathname)
      .toBe('/stream/tok/e7/video.m3u8')
    expect(new URL('init_0.mp4', `https://app.example.com${master}`).pathname)
      .toBe('/stream/tok/e7/init_0.mp4')
  })

  // Two generations of the same room do NOT share a URL: that is what stops the
  // browser's cache (or the relay's) serving the previous movie's bytes, because
  // init_0.mp4 and seg_0_00000.m4s are named identically in both.
  it('two epochs of the same room do not share a URL', () => {
    expect(streamUrl('', 'tok', 1, 'seg_0_00000.m4s'))
      .not.toBe(streamUrl('', 'tok', 2, 'seg_0_00000.m4s'))
  })
})
