import { describe, it, expect, vi } from 'vitest'
import { getLibrary, createRoom } from '../src/api'

describe('api client', () => {
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
