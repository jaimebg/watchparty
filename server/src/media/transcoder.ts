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

// Margen antes de dar por perdido a ffmpeg. Tiene que superar con holgura lo que
// cuesta un segmento (planSegments reparte cada 4 s), o una producción lenta se
// confundiría con un proceso ausente.
const FORWARD_GRACE_MS = 6_000

// Cuánto se lee de un segmento para encontrar y parchear su cabecera. Medido en
// un segmento de 4 s: styp+sidx+sidx+moof ocupan ~2,5 KB, así que 64 KB sobran
// de largo; si aun así no apareciera el mdat, se relee el archivo entero.
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
  // Timescale de cada pista, por variante, sacado del init al fijarlo. Hace
  // falta para retimear los segmentos, y no se puede deducir del plan: cada
  // pista tiene el suyo (medido con la fixture de test, rate=24: vídeo 12288,
  // audio 44100).
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
    // Ya estamos produciendo desde ahí: matar el proceso que justo está llenando
    // ese hueco solo reiniciaría el trabajo desde cero. Sin esta guarda, las
    // peticiones de vídeo y de audio del mismo índice se matan entre sí en bucle.
    // `exitCode` a solas no vale como prueba de vida: también es null cuando una
    // señal (OOM, SIGSEGV) se llevó el proceso, y ese sí hay que relanzarlo.
    if (segmentIndex === this.startSegment && this.proc
        && this.proc.exitCode === null && this.proc.signalCode === null) return
    // Seek a una zona ya cacheada: reiniciar ffmpeg ahí regeneraría segmentos
    // ya servibles y reescribiría init_*.mp4 mientras algún cliente los
    // descarga, sin producir nada nuevo. Se comprueban todas las variantes
    // porque la poda de caché puede haber borrado el audio y no el vídeo.
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

  // El init de fMP4 se reescribe entero en cada reinicio de ffmpeg. Un cliente
  // que lo descargue en ese instante se lleva un archivo truncado: el vídeo no
  // decodifica pero los <track> nativos siguen pintando subtítulos, que es
  // exactamente el síntoma reportado. Se entrega siempre una copia estable.
  async requestInit(variant: number, timeoutMs = 30_000): Promise<string> {
    if (this.closed) throw new Error(`Sesión cerrada esperando init v${variant}`)
    const stable = join(this.opts.outDir, `init_${variant}.stable.mp4`)
    if (existsSync(stable)) { this.loadTimescales(variant, stable); return stable }
    const live = join(this.opts.outDir, `init_${variant}.mp4`)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // Una sesión parada ya no es dueña de su roomDir: retry() borra los
      // snapshots y monta una sesión nueva encima, así que copiar aquí
      // resucitaría el init de la ejecución rota.
      if (this.closed) throw new Error(`Sesión cerrada esperando init v${variant}`)
      // El muxer HLS escribe y cierra el init antes de cerrar el primer
      // segmento, así que ver el segmento —que con temp_file solo aparece ya
      // completo— prueba que el init está entero. Pero eso solo vale si ESE
      // segmento lo escribió el proceso actual: uno que sobrevive de una
      // ejecución anterior (frontier seek, o retry() reanudando en 0) no
      // demuestra nada sobre el init que este proceso acaba de reescribir.
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
    throw new Error(`Timeout esperando init v${variant}`)
  }

  // Un snapshot que ya existía (misma sesión, otra variante ya servida) no pasó
  // por el set de arriba. canonicalizeInit es idempotente sobre un init ya
  // canónico, así que releerlo es la forma barata de recuperar sus timescales.
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
      // ffmpeg no viene de camino y esperar el plazo entero solo acaba en 504.
      // Las tres condiciones acotan el falso positivo:
      // - `index > startSegment + 1`: nunca matamos al proceso que está produciendo
      //   el segmento contiguo, que en modo transcode puede tardar más que la gracia.
      // - el segmento pedido no existe: si existe, ffmpeg pasó por ahí y solo falta
      //   que cierre el siguiente.
      // - el anterior tampoco: su ausencia solo prueba algo junto a la condición
      //   anterior, porque la poda de caché (cada 60 s, index.ts) borra segmentos
      //   viejos de salas vivas.
      if (!restarted && Date.now() >= forwardAt && index > this.startSegment + 1
          && !existsSync(this.segPath(variant, index))
          && !existsSync(this.segPath(variant, index - 1))) {
        restarted = true
        this.seekTo(index)
      }
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`Timeout esperando segmento v${variant}#${index}`)
  }

  /**
   * El segmento listo para servir: los mismos bytes que escribió ffmpeg pero con
   * la cabecera reanclada al instante que la playlist declara para ese índice.
   *
   * Solo la cabecera pasa por memoria; el `mdat` (megas) sigue viajando en
   * streaming desde disco.
   */
  async openSegment(variant: number, index: number, timeoutMs = 30_000): Promise<Readable> {
    const path = await this.requestSegment(variant, index, timeoutMs)
    // Garantiza que el init está fijado, que es de donde salen los timescales.
    await this.requestInit(variant, timeoutMs)
    const timescales = this.timescales.get(variant)
    const start = this.segments[index]?.start
    if (!timescales || start === undefined) return createReadStream(path)

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
      // Sin `mdat` no hay segmento: servirlo tal cual sería resucitar el fallo
      // en silencio, así que se prefiere el 504 que ya devuelve la ruta.
      if (headLen < 0) throw new Error(`Segmento sin mdat v${variant}#${index}`)
      head = retimeHeader(probe.subarray(0, headLen), timescales, start)
    } finally {
      await fh.close()
    }

    const out = new PassThrough()
    out.write(head)
    const rest = createReadStream(path, { start: headLen })
    // pipeline() en vez de rest.pipe(out) a mano: un pipe manual solo
    // propaga hacia delante, así que cuando el consumidor destruye `out` a
    // media descarga (hls.js aborta la petición del segmento en cada seek y
    // en cada cambio de ABR) Node solo hace unpipe() y PAUSA `rest` sin
    // destruirlo — el fd (y su buffer de 64 KB) se queda abierto para
    // siempre. Medido: tras out.destroy(), rest.destroyed=false,
    // rest.closed=false. pipeline() destruye el origen en cuanto el destino
    // se cierra antes de tiempo, en cualquier dirección.
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
