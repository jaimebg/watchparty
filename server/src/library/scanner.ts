import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { cleanName } from './nameClean.js'

export interface LibraryItem {
  id: string; path: string; title: string
  /** Nombre de la carpeta contenedora, para la etiqueta de la UI. */
  folderName: string
  /**
   * Ruta absoluta de la carpeta contenedora. Es esto y no `folderName` lo que
   * identifica un grupo: dos series pueden tener una «Season 1» cada una, y
   * agrupar por basename las fusiona en una sección con episodios de las dos.
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
  // Un solo listado por directorio, no uno por vídeo: con 200 episodios en una
  // carpeta, emparejar los .srt leyéndola cada vez son 200 lecturas del mismo
  // sitio. Y desde que se puede elegir película DENTRO de la sala, este escaneo
  // corre en mitad de la función, no solo en la portada.
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
