import { spawn, ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { buildTranscodeArgs } from './ffmpegArgs.js'
import type { Segment } from './planner.js'

interface Opts { input: string; mode: 'copy' | 'transcode'; encoder: string; segments: Segment[]; audioCount: number; outDir: string }

export class TranscodeSession {
  lastLog: string[] = []
  private proc: ChildProcess | null = null
  private startSegment = 0
  private finished = false
  private killing = false
  private errorCb: ((log: string[]) => void) | null = null
  private segments: Segment[]

  constructor(private opts: Opts) { this.segments = opts.segments }

  start(fromSegment = 0): void {
    this.startSegment = fromSegment
    this.finished = false
    const args = buildTranscodeArgs({ ...this.opts, startSegment: fromSegment })
    this.proc = spawn(ffmpegPath as unknown as string, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.proc.stderr!.on('data', (d: Buffer) => {
      this.lastLog.push(...d.toString().split('\n').filter(Boolean))
      this.lastLog = this.lastLog.slice(-50)
    })
    this.proc.on('exit', code => {
      if (code === 0) this.finished = true
      else if (!this.killing) this.errorCb?.(this.lastLog)
      this.killing = false
    })
  }

  onError(cb: (log: string[]) => void): void { this.errorCb = cb }

  seekTo(segmentIndex: number): void {
    this.killProc()
    this.start(segmentIndex)
  }

  private segPath(variant: number, index: number): string {
    return join(this.opts.outDir, `seg_${variant}_${String(index).padStart(5, '0')}.m4s`)
  }

  private isReady(variant: number, index: number): boolean {
    if (!existsSync(this.segPath(variant, index))) return false
    return this.finished || existsSync(this.segPath(variant, index + 1))
  }

  async requestSegment(variant: number, index: number, timeoutMs = 30_000): Promise<string> {
    if (this.isReady(variant, index)) return this.segPath(variant, index)
    if (index < this.startSegment && !existsSync(this.segPath(variant, index))) this.seekTo(index)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.isReady(variant, index)) return this.segPath(variant, index)
      if (this.finished && existsSync(this.segPath(variant, index))) return this.segPath(variant, index)
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`Timeout esperando segmento v${variant}#${index}`)
  }

  private killProc(): void {
    if (this.proc && this.proc.exitCode === null) { this.killing = true; this.proc.kill('SIGKILL') }
    this.proc = null
  }

  async stop(): Promise<void> {
    const p = this.proc
    this.killProc()
    if (p && p.exitCode === null) await new Promise(r => p.once('exit', r))
  }
}
