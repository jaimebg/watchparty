import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffprobeStatic from 'ffprobe-static'

const pExecFile = promisify(execFile)
const FFPROBE = ffprobeStatic.path

export interface AudioTrack { index: number; codec: string; lang: string; label: string; channels: number }
export interface SubTrack { index: number; codec: string; lang: string; label: string; textBased: boolean }
export interface MediaInfo { durationSec: number; videoCodec: string; width: number; height: number; audio: AudioTrack[]; subs: SubTrack[] }

const TEXT_SUB_CODECS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text'])

export async function probeFile(path: string): Promise<MediaInfo> {
  const { stdout } = await pExecFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
  const json = JSON.parse(stdout)
  const streams: any[] = json.streams ?? []
  const video = streams.find(s => s.codec_type === 'video')
  if (!video) throw new Error(`Sin pista de vídeo: ${path}`)
  const audioStreams = streams.filter(s => s.codec_type === 'audio')
  const subStreams = streams.filter(s => s.codec_type === 'subtitle')
  return {
    durationSec: Number(json.format?.duration ?? 0),
    videoCodec: video.codec_name,
    width: video.width, height: video.height,
    audio: audioStreams.map((s, i) => ({
      index: i, codec: s.codec_name, lang: s.tags?.language ?? 'und',
      label: s.tags?.title ?? `Pista ${i + 1}`, channels: s.channels ?? 2,
    })),
    subs: subStreams.map((s, i) => ({
      index: i, codec: s.codec_name, lang: s.tags?.language ?? 'und',
      label: s.tags?.title ?? `Subtítulo ${i + 1}`, textBased: TEXT_SUB_CODECS.has(s.codec_name),
    })),
  }
}

export async function extractKeyframes(path: string): Promise<number[]> {
  const { stdout } = await pExecFile(FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path],
    { maxBuffer: 256 * 1024 * 1024 })
  const times: number[] = []
  for (const line of stdout.split('\n')) {
    const [pts, flags] = line.split(',')
    if (flags?.includes('K') && pts !== 'N/A' && pts) times.push(Number(pts))
  }
  return times.sort((a, b) => a - b)
}
