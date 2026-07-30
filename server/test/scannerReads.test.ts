import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const reads: string[] = []

// Interceptar el módulo (y no espiar el namespace) es lo único fiable aquí: el
// escáner hace `import { readdir } from 'node:fs/promises'`, y ese binding ya
// está resuelto cuando un spy sobre el namespace llegaría.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: ((path: Parameters<typeof actual.readdir>[0], opts?: Parameters<typeof actual.readdir>[1]) => {
      reads.push(String(path))
      return actual.readdir(path as string, opts as undefined)
    }) as unknown as typeof actual.readdir,
  }
})

const { scanLibrary } = await import('../src/library/scanner.js')

describe('scanLibrary', () => {
  it('hace un readdir por directorio, no uno por vídeo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-reads-'))
    for (let i = 0; i < 8; i++) writeFileSync(join(root, `Ep${i}.mkv`), '')
    reads.length = 0

    const items = await scanLibrary([root])

    expect(items).toHaveLength(8)
    // Uno de walk() y uno para emparejar los .srt. Antes eran 1 + 8: con 200
    // episodios en una carpeta, 200 lecturas del mismo sitio.
    expect(reads.filter(p => p === root)).toHaveLength(2)
  })
})
