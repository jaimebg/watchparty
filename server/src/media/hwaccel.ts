import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'

const pExecFile = promisify(execFile)
let cached: string | null = null

export function parseEncoders(encodersOutput: string, platform: NodeJS.Platform): string {
  const has = (name: string) => new RegExp(`\\b${name}\\b`).test(encodersOutput)
  if (platform === 'darwin' && has('h264_videotoolbox')) return 'h264_videotoolbox'
  if (platform === 'win32') {
    if (has('h264_nvenc')) return 'h264_nvenc'
    if (has('h264_qsv')) return 'h264_qsv'
  }
  return 'libx264'
}

export async function detectEncoder(): Promise<string> {
  if (cached) return cached
  const { stdout } = await pExecFile(ffmpegPath as unknown as string, ['-hide_banner', '-encoders'])
  cached = parseEncoders(stdout, process.platform)
  return cached
}
