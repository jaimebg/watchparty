import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface PrunableFile { path: string; mtimeMs: number; size: number }

export function pickPrunable(files: PrunableFile[], limitBytes: number): string[] {
  let total = files.reduce((s, f) => s + f.size, 0)
  const out: string[] = []
  for (const f of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= limitBytes) break
    out.push(f.path)
    total -= f.size
  }
  return out
}

export function segmentFilesWithStats(dir: string): PrunableFile[] {
  try {
    return readdirSync(dir).filter(n => n.endsWith('.m4s')).map(n => {
      const path = join(dir, n)
      const st = statSync(path)
      return { path, mtimeMs: st.mtimeMs, size: st.size }
    })
  } catch { return [] }
}
