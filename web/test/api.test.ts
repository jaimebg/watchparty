import { describe, it, expect, vi } from 'vitest'
import { bootstrapAdmin, getLibrary, createRoom } from '../src/api'
import { lang } from '../src/i18n'

// Every request advertises the detected UI language: the server answers API
// errors in it and picks the TMDB metadata language for the whole room.
const sentLanguage = (spy: { mock: { calls: unknown[][] } }, call = 0) =>
  (((spy.mock.calls[call][1] as RequestInit | undefined)?.headers ?? {}) as Record<string, string>)['accept-language']

describe('api client', () => {
  it('bootstrapAdmin exchanges ?key= for the admin cookie via /api/status', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    expect(await bootstrapAdmin('?key=abc%20d')).toBe(true)
    expect(spy).toHaveBeenCalledWith('/api/status?key=abc%20d', { headers: { 'accept-language': lang } })
    spy.mockRestore()
  })
  it('bootstrapAdmin is a no-op without key', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    expect(await bootstrapAdmin('')).toBe(false)
    expect(await bootstrapAdmin('?other=1')).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('getLibrary GETs /api/library advertising the UI language', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'))
    await getLibrary()
    expect(spy.mock.calls[0][0]).toBe('/api/library')
    expect(sentLanguage(spy as never)).toBe(lang)
    spy.mockRestore()
  })
  it('createRoom POSTs itemId keeping its content-type header', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"token":"t"}'))
    const r = await createRoom('abc')
    expect(r.token).toBe('t')
    expect(spy.mock.calls[0][0]).toBe('/api/rooms')
    const init = spy.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({ itemId: 'abc' })
    expect(sentLanguage(spy as never)).toBe(lang)
    spy.mockRestore()
  })
})
