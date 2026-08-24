import { execFile } from 'node:child_process'
import { openSync, readSync, closeSync } from 'node:fs'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import type { MediaInfo } from './probe.js'
import { detectLangFromText, guessLangFromName, langLabel } from './lang.js'

const pExecFile = promisify(execFile)

export interface SubtitleOption { id: number; label: string; lang: string }

function srtSample(path: string): string {
  try {
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(16 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  }
}

// Language of an external .srt: hints in the name first (.es.srt, "Spanish", …),
// otherwise a heuristic over the content. null when there is no signal.
function srtLang(path: string): string | null {
  return guessLangFromName(basename(path)) ?? detectLangFromText(srtSample(path))
}

export function listSubtitleOptions(info: MediaInfo, srtFiles: string[]): SubtitleOption[] {
  const embedded = info.subs.filter(s => s.textBased)
  const opts: SubtitleOption[] = embedded.map((s, i) => ({
    id: i,
    label: langLabel(s.lang) ?? s.label,
    lang: s.lang,
  }))
  srtFiles.forEach((f, i) => {
    const lang = srtLang(f)
    opts.push({ id: embedded.length + i, label: langLabel(lang) ?? basename(f, '.srt'), lang: lang ?? 'und' })
  })
  // Repeated labels (embedded "Español" + external "Español") get numbered.
  const seen = new Map<string, number>()
  for (const o of opts) {
    const n = (seen.get(o.label) ?? 0) + 1
    seen.set(o.label, n)
    if (n > 1) o.label = `${o.label} (${n})`
  }
  return opts
}

export async function extractSubtitle(input: string, info: MediaInfo, srtFiles: string[], id: number, outVtt: string): Promise<void> {
  const embedded = info.subs.filter(s => s.textBased)
  if (id < embedded.length) {
    await pExecFile(ffmpegPath as unknown as string, ['-y', '-i', input, '-map', `0:s:${embedded[id].index}`, '-f', 'webvtt', outVtt])
  } else {
    const srt = srtFiles[id - embedded.length]
    if (!srt) throw new Error(`Subtitle ${id} does not exist`)
    await pExecFile(ffmpegPath as unknown as string, ['-y', '-i', srt, '-f', 'webvtt', outVtt])
  }
}
