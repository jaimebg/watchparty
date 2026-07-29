import { describe, it, expect } from 'vitest'
import { parseRoomToken, roomLink } from '../src/pages/roomToken'

const TOKEN = 'AbC123_xY-z9QwErTyUi'

describe('parseRoomToken', () => {
  it('accepts a bare token', () => {
    expect(parseRoomToken(TOKEN)).toBe(TOKEN)
  })
  it('trims surrounding whitespace', () => {
    expect(parseRoomToken(`  ${TOKEN}\n`)).toBe(TOKEN)
  })
  it('pulls the token out of a pasted room URL', () => {
    expect(parseRoomToken(`https://watchparty.example.com/room/${TOKEN}`)).toBe(TOKEN)
  })
  it('handles a trailing slash and a query string', () => {
    expect(parseRoomToken(`https://x.test/room/${TOKEN}/`)).toBe(TOKEN)
    expect(parseRoomToken(`https://x.test/room/${TOKEN}?foo=1`)).toBe(TOKEN)
  })
  it('rejects empty input', () => {
    expect(parseRoomToken('')).toBeNull()
    expect(parseRoomToken('   ')).toBeNull()
  })
  it('rejects arbitrary text and too-short tokens', () => {
    expect(parseRoomToken('no es un token')).toBeNull()
    expect(parseRoomToken('abc')).toBeNull()
  })
  it('rejects a URL that is not a room link', () => {
    expect(parseRoomToken('https://x.test/library')).toBeNull()
  })
})

describe('roomLink', () => {
  it('joins origin and token', () => {
    expect(roomLink('https://x.trycloudflare.com', TOKEN)).toBe(`https://x.trycloudflare.com/room/${TOKEN}`)
  })
  it('drops a hand-typed trailing slash instead of emitting //room/', () => {
    expect(roomLink('https://watchparty.example.com/', TOKEN)).toBe(`https://watchparty.example.com/room/${TOKEN}`)
    expect(roomLink('https://watchparty.example.com///', TOKEN)).toBe(`https://watchparty.example.com/room/${TOKEN}`)
  })
  it('trims surrounding whitespace from a config-file origin', () => {
    expect(roomLink('  https://x.test  ', TOKEN)).toBe(`https://x.test/room/${TOKEN}`)
  })
  it('round-trips through parseRoomToken', () => {
    expect(parseRoomToken(roomLink('https://x.test/', TOKEN))).toBe(TOKEN)
  })
})
