import { spawn, ChildProcess } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Readable, pipeline } from 'node:stream'
import ffmpegPath from 'ffmpeg-static'
import { buildTranscodeArgs } from './ffmpegArgs.js'
import { canonicalizeInit, headerLength, retimeHeader } from './fmp4.js'
import { variantCount } from './hlsLayout.js'
import type { Segment } from './planner.js'

// Grace period before giving ffmpeg up for lost. It has to comfortably exceed
// what one segment costs (planSegments lays them out every 4 s), or slow
// production would be mistaken for a missing process.
const FORWARD_GRACE_MS = 6_000

// How much of a segment is read to find and patch its header. Measured on a 4 s
// segment: styp+sidx+sidx+moof take ~2.5 KB, so 64 KB is plenty; if the mdat
// still does not show up, the whole file is re-read.
const HEAD_PROBE_BYTES = 64 * 1024

interface Opts { input: string; mode: 'copy' | 'transcode'; encoder: string; segments: Segment[]; audioCount: number; outDir: string }

export class TranscodeSession {
  lastLog: string[] = []
  private proc: ChildProcess | null = null
  private startSegment = 0
  private finished = false
  // Per-process intentional-kill marker. A shared boolean would race when a
  // seekTo() overlaps with the previous process's own exit event (the old
  // process's exit handler could reset the flag before/after the new kill,
  // producing false errorCb firings or swallowing real ones). Keying off the
  // ChildProcess instance itself (captured locally in each start() closure)
  // makes each exit handler check only its own process's kill status.
  private killedProcs = new WeakSet<ChildProcess>()
  private errorCb: ((log: string[]) => void) | null = null
  private segments: Segment[]
  // Set by stop() once the room that owns this session is torn down (roomDir
  // deleted, cleanup done). Without this, a seek arriving after the room was
  // closed would respawn ffmpeg against a directory that no longer exists.
  private closed = false
  private initCopies = 0
  // Each track's timescale, per variant, taken from the init when it is pinned.
  // Needed to retime the segments, and not derivable from the plan: every track
  // has its own (measured with the test fixture, rate=24: video 12288, audio
  // 44100).
  private timescales = new Map<number, Map<number, number>>()
  // When the currently-running process was spawned. requestInit's proof below
  // ("seeing the segment proves the init is whole") only holds for a segment
  // the CURRENT process wrote: a leftover *.m4s from a previous run (still on
  // disk after a frontier seek, or surviving retry()'s cache wipe) proves
  // nothing about the init this process just started rewriting.
  private procStartedAt = 0

  constructor(private opts: Opts) { this.segments = opts.segments }

  start(fromSegment = 0): void {
    if (this.closed) return
    this.startSegment = fromSegment
    this.finished = false
    const args = buildTranscodeArgs({ ...this.opts, startSegment: fromSegment })
    const proc = spawn(ffmpegPath as unknown as string, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.proc = proc
    this.procStartedAt = Date.now()
    proc.stderr!.on('data', (d: Buffer) => {
      this.lastLog.push(...d.toString().split('\n').filter(Boolean))
      this.lastLog = this.lastLog.slice(-50)
    })
    proc.on('exit', code => {
      if (code === 0) this.finished = true
      else if (!this.killedProcs.has(proc)) this.errorCb?.(this.lastLog)
      this.killedProcs.delete(proc)
    })
  }

  onError(cb: (log: string[]) => void): void { this.errorCb = cb }

  seekTo(segmentIndex: number): void {
    if (this.closed) return
    // We are already producing from there: killing the process that is filling
    // exactly that gap would only restart the work from scratch. Without this
    // guard, the video and audio requests for the same index kill each other in
    // a loop. `exitCode` alone is no proof of life: it is also null when a signal
    // (OOM, SIGSEGV) took the process down, and that one does need relaunching.
    if (segmentIndex === this.startSegment && this.proc
        && this.proc.exitCode === null && this.proc.signalCode === null) return
    // Seek into already-cached territory: restarting ffmpeg there would
    // regenerate servable segments and rewrite init_*.mp4 while some client is
    // downloading them, producing nothing new. Every variant is checked because
    // cache pruning may have deleted the audio and not the video.
    let ready = true
    for (let v = 0; v < variantCount(this.opts.audioCount); v++) if (!this.isReady(v, segmentIndex)) { ready = false; break }
    if (ready) return
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

  // A leftover segment from a previous run (frontier seek: the new process
  // restarts exactly where an old segment already sits; retry(): the old
  // run's numbering starts at 0 too) proves nothing about the CURRENT
  // process's init file. Only a segment written at or after this process's
  // own spawn time is proof the muxer has already flushed this process's
  // init. Missing or unstattable (e.g. a race with pruning) counts as "not
  // proof yet", not an error.
  private segFreshEnough(path: string): boolean {
    try {
      return statSync(path).mtimeMs >= this.procStartedAt
    } catch {
      return false
    }
  }

  // The fMP4 init is rewritten in full on every ffmpeg restart. A client
  // downloading it at that instant gets a truncated file: the video does not
  // decode but the native <track> elements keep painting subtitles, which is
  // exactly the reported symptom. A stable copy is always served instead.
  async requestInit(variant: number, timeoutMs = 30_000): Promise<string> {
    if (this.closed) throw new Error(`Session closed waiting for init v${variant}`)
    const stable = join(this.opts.outDir, `init_${variant}.stable.mp4`)
    if (existsSync(stable)) { this.loadTimescales(variant, stable); return stable }
    const live = join(this.opts.outDir, `init_${variant}.mp4`)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // A stopped session no longer owns its roomDir: retry() deletes the
      // snapshots and stands a new session up on top, so copying here would
      // resurrect the broken run's init.
      if (this.closed) throw new Error(`Session closed waiting for init v${variant}`)
      // The HLS muxer writes and closes the init before closing the first
      // segment, so seeing the segment — which with temp_file only appears once
      // complete — proves the init is whole. But that only holds if THAT segment
      // was written by the current process: one surviving from an earlier run
      // (frontier seek, or retry() resuming at 0) proves nothing about the init
      // this process has just rewritten.
      if (existsSync(live) && (this.finished || this.segFreshEnough(this.segPath(variant, this.startSegment)))) {
        const { init, timescales } = canonicalizeInit(readFileSync(live))
        const tmp = `${stable}.${this.initCopies++}.tmp`
        writeFileSync(tmp, init)
        renameSync(tmp, stable)
        this.timescales.set(variant, timescales)
        return stable
      }
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`Timed out waiting for init v${variant}`)
  }

  // A snapshot that already existed (same session, another variant already
  // served) never went through the set above. canonicalizeInit is idempotent on
  // an already-canonical init, so re-reading it is the cheap way to recover its
  // timescales.
  private loadTimescales(variant: number, stable: string): void {
    if (this.timescales.has(variant)) return
    this.timescales.set(variant, canonicalizeInit(readFileSync(stable)).timescales)
  }

  async requestSegment(variant: number, index: number, timeoutMs = 30_000): Promise<string> {
    if (this.isReady(variant, index)) return this.segPath(variant, index)
    let restarted = false
    if (index < this.startSegment && !existsSync(this.segPath(variant, index))) {
      this.seekTo(index)
      restarted = true
    }
    const deadline = Date.now() + timeoutMs
    const forwardAt = Date.now() + FORWARD_GRACE_MS
    while (Date.now() < deadline) {
      if (this.isReady(variant, index)) return this.segPath(variant, index)
      if (this.finished && existsSync(this.segPath(variant, index))) return this.segPath(variant, index)
      // ffmpeg is not on its way and waiting out the full deadline only ends in
      // a 504. Three conditions bound the false positive:
      // - `index > startSegment + 1`: we never kill the process producing the
      //   adjacent segment, which in transcode mode can take longer than the grace.
      // - the requested segment does not exist: if it does, ffmpeg went past it
      //   and all that is missing is closing the next one.
      // - nor does the previous one: its absence only proves something alongside
      //   the condition above, because cache pruning (every 60 s, index.ts)
      //   deletes old segments from live rooms.
      if (!restarted && Date.now() >= forwardAt && index > this.startSegment + 1
          && !existsSync(this.segPath(variant, index))
          && !existsSync(this.segPath(variant, index - 1))) {
        restarted = true
        this.seekTo(index)
      }
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`Timed out waiting for segment v${variant}#${index}`)
  }

  /**
   * The segment ready to serve: the same bytes ffmpeg wrote, but with the header
   * re-anchored to the instant the playlist declares for that index.
   *
   * Only the header passes through memory; the `mdat` (megabytes) keeps
   * streaming straight off disk.
   */
  async openSegment(variant: number, index: number, timeoutMs = 30_000): Promise<Readable> {
    const path = await this.requestSegment(variant, index, timeoutMs)
    // Guarantees the init is pinned, which is where the timescales come from.
    await this.requestInit(variant, timeoutMs)
    const timescales = this.timescales.get(variant)
    const start = this.segments[index]?.start
    // `start === undefined` happens with an index outside the plan
    // (>= this.segments.length): api.ts already validates this before we get
    // here, but if it ever stopped doing so, serving the file as-is without
    // re-anchoring would silently resurrect the very bug this class exists to
    // kill (same spirit as the "without mdat" throw below: a 504 beats a mute
    // bug).
    if (!timescales || start === undefined) throw new Error(`No plan to re-anchor v${variant}#${index}`)

    const fh = await open(path, 'r')
    let head: Buffer
    let headLen: number
    try {
      const size = (await fh.stat()).size
      let probe = Buffer.alloc(Math.min(HEAD_PROBE_BYTES, size))
      await fh.read(probe, 0, probe.length, 0)
      headLen = headerLength(probe)
      if (headLen < 0 && probe.length < size) {
        probe = Buffer.alloc(size)
        await fh.read(probe, 0, size, 0)
        headLen = headerLength(probe)
      }
      // Without an `mdat` there is no segment: serving it as-is would resurrect
      // the bug silently, so the 504 the route already returns is preferable.
      if (headLen < 0) throw new Error(`Segment without mdat v${variant}#${index}`)
      head = retimeHeader(probe.subarray(0, headLen), timescales, start)
    } finally {
      await fh.close()
    }

    const out = new PassThrough()
    out.write(head)
    const rest = createReadStream(path, { start: headLen })
    // pipeline() rather than a hand-rolled rest.pipe(out): a manual pipe only
    // propagates forward, so when the consumer destroys `out` mid-download
    // (hls.js aborts the segment request on every seek and every ABR switch)
    // Node merely unpipe()s and PAUSES `rest` without destroying it — the fd
    // (and its 64 KB buffer) stays open forever. Measured: after out.destroy(),
    // rest.destroyed=false, rest.closed=false. pipeline() destroys the source
    // the moment the destination closes early, in either direction.
    pipeline(rest, out, () => {})
    return out
  }

  private killProc(): void {
    const p = this.proc
    if (p && p.exitCode === null) { this.killedProcs.add(p); p.kill('SIGKILL') }
    this.proc = null
  }

  async stop(): Promise<void> {
    this.closed = true
    const p = this.proc
    this.killProc()
    if (p && p.exitCode === null) await new Promise(r => p.once('exit', r))
  }
}
