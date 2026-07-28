import ffmpegPath from 'ffmpeg-static'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './run.js'

const SRT = '1\n00:00:01,000 --> 00:00:03,000\nHola fixture\n\n2\n00:00:05,000 --> 00:00:07,000\nSegunda línea\n'

export async function makeFixtureMkv(dir: string, opts: { seconds?: number; withSubs?: boolean } = {}): Promise<string> {
  const { seconds = 10, withSubs = true } = opts
  const out = join(dir, 'fixture.mkv')
  const srt = join(dir, 'fixture-src.srt')
  const args = ['-y',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=24:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=880:duration=${seconds}`,
  ]
  if (withSubs) { writeFileSync(srt, SRT); args.push('-i', srt) }
  args.push('-map', '0:v', '-map', '1:a', '-map', '2:a')
  if (withSubs) args.push('-map', '3:s')
  args.push(
    '-metadata:s:a:0', 'language=spa', '-metadata:s:a:1', 'language=eng',
    '-c:v', 'libx264', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
  )
  await run(ffmpegPath as unknown as string, args)
  return out
}
