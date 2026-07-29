import { describe, it, expect, vi } from 'vitest'
import { bootstrapAdmin, getLibrary, createRoom } from '../src/api'

describe('api client', () => {
  it('bootstrapAdmin exchanges ?key= for the admin cookie via /api/status', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    expect(await bootstrapAdmin('?key=abc%20d')).toBe(true)
    expect(spy).toHaveBeenCalledWith('/api/status?key=abc%20d')
    spy.mockRestore()
  })
  it('bootstrapAdmin is a no-op without key', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    expect(await bootstrapAdmin('')).toBe(false)
    expect(await bootstrapAdmin('?other=1')).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('getLibrary GETs /api/library', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'))
    await getLibrary()
    expect(spy).toHaveBeenCalledWith('/api/library')
    spy.mockRestore()
  })
  it('createRoom POSTs itemId', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"token":"t"}'))
    const r = await createRoom('abc')
    expect(r.token).toBe('t')
    expect(spy.mock.calls[0][0]).toBe('/api/rooms')
    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)).toEqual({ itemId: 'abc' })
    spy.mockRestore()
  })
})
