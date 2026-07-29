import { describe, it, expect } from 'vitest'
import { mapKlipyResponse } from '../src/http/klipy.js'

const sample = {
  result: true,
  data: {
    data: [{
      id: 123, title: 'lol',
      files: {
        sm: { gif: { url: 'https://k/sm.gif', width: 100, height: 80 } },
        md: { gif: { url: 'https://k/md.gif', width: 200, height: 160 } },
      },
    }, { id: 456, title: 'sin-files' }],
    has_next: true,
  },
}

describe('mapKlipyResponse', () => {
  it('maps items defensively', () => {
    const r = mapKlipyResponse(sample)
    expect(r).toHaveLength(1)
    expect(r[0]).toEqual({ id: '123', title: 'lol', previewUrl: 'https://k/sm.gif', url: 'https://k/md.gif', width: 200, height: 160 })
  })
  it('tolerates garbage', () => {
    expect(mapKlipyResponse(null)).toEqual([])
    expect(mapKlipyResponse({ data: {} })).toEqual([])
  })
  it('also accepts the singular `file` field (observed in real KLIPY responses; docs show `files`)', () => {
    const singular = {
      data: { data: [{
        id: 789, title: 'singular',
        file: { md: { gif: { url: 'https://k/singular-md.gif', width: 300, height: 240 } } },
      }] },
    }
    const r = mapKlipyResponse(singular)
    expect(r).toEqual([{ id: '789', title: 'singular', previewUrl: 'https://k/singular-md.gif', url: 'https://k/singular-md.gif', width: 300, height: 240 }])
  })
})
