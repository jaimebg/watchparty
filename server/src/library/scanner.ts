import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { cleanName } from './nameClean.js'

export interface LibraryItem {
  id: string; path: string; title: string
  /** Name of the containing folder, for the UI label. */
  folderName: string
  /**
   * Absolute path of the containing folder. This, and not `folderName`, is what
   * identifies a group: two series can each have a "Season 1", and grouping by
   * basename merges them into one section holding episodes from both.
   */
  folderPath: string
  srtFiles: string[]
}

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
  // One listing per directory, not one per video: with 200 episodes in a folder,
  // pairing up the .srt files by re-reading it every time is 200 reads of the
  // same place. And since movies can be picked from INSIDE the room, this scan
  // runs mid-session, not only on the landing page.
  const srtByDir = new Map<string, string[]>()
  for (const dir of new Set(files.map(f => dirname(f)))) {
    const names = await readdir(dir).catch(() => [] as string[])
    srtByDir.set(dir, names.filter(n => n.endsWith('.srt')))
  }
  const items: LibraryItem[] = files.map(path => {
    const dir = dirname(path)
    const base = basename(path, extname(path))
    const siblings = (srtByDir.get(dir) ?? []).filter(n => n.startsWith(base))
    return {
      id: createHash('sha1').update(path).digest('hex'),
      path,
      title: cleanName(basename(path)),
      folderName: basename(dir),
      folderPath: dir,
      srtFiles: siblings.map(n => join(dir, n)),
    }
  })
  return items.sort((a, b) => a.folderName.localeCompare(b.folderName) || a.path.localeCompare(b.path))
}
