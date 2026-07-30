import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanLibrary } from '../src/library/scanner.js'

describe('scanLibrary', () => {
  it('finds videos recursively with adjacent srt, skips other files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-'))
    mkdirSync(join(root, 'SerieX', 'Season1'), { recursive: true })
    writeFileSync(join(root, 'Peli.2020.1080p.mkv'), '')
    writeFileSync(join(root, 'Peli.2020.1080p.es.srt'), '')
    writeFileSync(join(root, 'notas.txt'), '')
    writeFileSync(join(root, 'SerieX', 'Season1', 'SerieX.S01E01.mp4'), '')
    const items = await scanLibrary([root, '/no/existe'])
    expect(items).toHaveLength(2)
    const peli = items.find(i => i.path.endsWith('.mkv'))!
    expect(peli.title).toBe('Peli 2020')
    expect(peli.srtFiles).toHaveLength(1)
    const ep = items.find(i => i.path.endsWith('.mp4'))!
    expect(ep.folderName).toBe('Season1')
    expect(ep.folderPath).toBe(join(root, 'SerieX', 'Season1'))
    expect(ep.id).toMatch(/^[a-f0-9]{40}$/)
  })

  // basename() a solas fusiona dos carpetas distintas que se llamen igual, y en
  // una biblioteca real («Season 1» de dos series) eso mezcla episodios de ambas
  // bajo una sola cabecera sin forma de distinguirlos.
  it('distingue dos carpetas homónimas por su ruta completa', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-dup-'))
    mkdirSync(join(root, 'Alien', 'Season 1'), { recursive: true })
    mkdirSync(join(root, 'Dune', 'Season 1'), { recursive: true })
    writeFileSync(join(root, 'Alien', 'Season 1', 'Alien.S01E01.mkv'), '')
    writeFileSync(join(root, 'Dune', 'Season 1', 'Dune.S01E01.mkv'), '')

    const items = await scanLibrary([root])
    expect(items).toHaveLength(2)
    expect(new Set(items.map(i => i.folderName))).toEqual(new Set(['Season 1']))
    expect(new Set(items.map(i => i.folderPath)).size).toBe(2)
    expect(items.every(i => i.folderPath.endsWith(join('Season 1')))).toBe(true)
  })

  it('empareja los .srt hermanos con sufijo de idioma tras agrupar los readdir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-srt-'))
    writeFileSync(join(root, 'Peli.mkv'), '')
    writeFileSync(join(root, 'Peli.srt'), '')
    writeFileSync(join(root, 'Peli.es.srt'), '')
    writeFileSync(join(root, 'Peli.en.srt'), '')
    writeFileSync(join(root, 'Otra.mkv'), '')
    writeFileSync(join(root, 'Otra.es.srt'), '')

    const items = await scanLibrary([root])
    const peli = items.find(i => i.path.endsWith('Peli.mkv'))!
    const otra = items.find(i => i.path.endsWith('Otra.mkv'))!
    expect(peli.srtFiles).toHaveLength(3)
    expect(otra.srtFiles).toHaveLength(1)
    expect(otra.srtFiles[0]).toBe(join(root, 'Otra.es.srt'))
  })
})
