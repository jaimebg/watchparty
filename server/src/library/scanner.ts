import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { cleanName } from './nameClean.js'

export interface LibraryItem { id: string; path: string; title: string; folderName: string; srtFiles: string[] }

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.webm'])

async function walk(dir: string, out: string[]): Promise<void> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (VIDEO_EXT.has(extname(e.name).toLowerCase())) out.push(p)
  }
}

export async function scanLibrary(folders: string[]): Promise<LibraryItem[]> {
  const files: string[] = []
  for (const f of folders) await walk(resolve(f), files)
  const items: LibraryItem[] = []
  for (const path of files) {
    const dir = dirname(path)
    const base = basename(path, extname(path))
    const siblings = (await readdir(dir)).filter(n => n.endsWith('.srt') && n.startsWith(base))
    items.push({
      id: createHash('sha1').update(path).digest('hex'),
      path,
      title: cleanName(basename(path)),
      folderName: basename(dir),
      srtFiles: siblings.map(n => join(dir, n)),
    })
  }
  return items.sort((a, b) => a.folderName.localeCompare(b.folderName) || a.path.localeCompare(b.path))
}
