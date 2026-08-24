import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const reads: string[] = []

// Intercepting the module (rather than spying on the namespace) is the only
// reliable option here: the scanner does `import { readdir } from
// 'node:fs/promises'`, and that binding is already resolved by the time a spy on
// the namespace would arrive.
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
  it('does one readdir per directory, not one per video', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-reads-'))
    for (let i = 0; i < 8; i++) writeFileSync(join(root, `Ep${i}.mkv`), '')
    reads.length = 0

    const items = await scanLibrary([root])

    expect(items).toHaveLength(8)
    // One from walk() and one to pair up the .srt files. It used to be 1 + 8:
    // with 200 episodes in a folder, 200 reads of the same place.
    expect(reads.filter(p => p === root)).toHaveLength(2)
  })
})
