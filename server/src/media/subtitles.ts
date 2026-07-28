import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import type { MediaInfo } from './probe.js'

const pExecFile = promisify(execFile)

export interface SubtitleOption { id: number; label: string; lang: string }

export function listSubtitleOptions(info: MediaInfo, srtFiles: string[]): SubtitleOption[] {
  const embedded = info.subs.filter(s => s.textBased)
  const opts: SubtitleOption[] = embedded.map((s, i) => ({ id: i, label: s.label, lang: s.lang }))
  srtFiles.forEach((f, i) => opts.push({ id: embedded.length + i, label: basename(f, '.srt'), lang: 'und' }))
  return opts
}

export async function extractSubtitle(input: string, info: MediaInfo, srtFiles: string[], id: number, outVtt: string): Promise<void> {
  const embedded = info.subs.filter(s => s.textBased)
  if (id < embedded.length) {
    await pExecFile(ffmpegPath as unknown as string, ['-y', '-i', input, '-map', `0:s:${embedded[id].index}`, '-f', 'webvtt', outVtt])
  } else {
    const srt = srtFiles[id - embedded.length]
    if (!srt) throw new Error(`Subtítulo ${id} no existe`)
    await pExecFile(ffmpegPath as unknown as string, ['-y', '-i', srt, '-f', 'webvtt', outVtt])
  }
}
