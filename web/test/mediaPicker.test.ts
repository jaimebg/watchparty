import { describe, it, expect } from 'vitest'
import { groupByFolder } from '../src/MediaPicker'
import type { LibraryItem } from '../src/types'

const item = (path: string, folderPath: string, folderName: string): LibraryItem =>
  ({ id: path, path, title: path, folderName, folderPath, srtFiles: [] })

describe('groupByFolder', () => {
  it('no fusiona dos carpetas distintas que se llamen igual', () => {
    const groups = groupByFolder([
      item('/m/Alien/Season 1/a.mkv', '/m/Alien/Season 1', 'Season 1'),
      item('/m/Dune/Season 1/b.mkv', '/m/Dune/Season 1', 'Season 1'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.every(g => g.items.length === 1)).toBe(true)
    expect(groups.map(g => g.name)).toEqual(['Season 1', 'Season 1'])
    expect(new Set(groups.map(g => g.path)).size).toBe(2)
  })

  it('agrupa los medios de una misma carpeta y conserva su orden', () => {
    const groups = groupByFolder([
      item('/m/S/1.mkv', '/m/S', 'S'),
      item('/m/S/2.mkv', '/m/S', 'S'),
      item('/m/T/3.mkv', '/m/T', 'T'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].items.map(i => i.path)).toEqual(['/m/S/1.mkv', '/m/S/2.mkv'])
    expect(groups[1].items).toHaveLength(1)
  })

  it('con la biblioteca vacía no devuelve grupos', () => {
    expect(groupByFolder([])).toEqual([])
  })
})
