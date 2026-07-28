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
    expect(ep.id).toMatch(/^[a-f0-9]{40}$/)
  })
})
