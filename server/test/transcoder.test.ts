import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import ffprobeStatic from 'ffprobe-static'
import { makeFixtureMkv } from './support/fixture.js'
import { extractKeyframes, probeFile } from '../src/media/probe.js'
import { planSegments } from '../src/media/planner.js'
import { TranscodeSession } from '../src/media/transcoder.js'
import { parseBoxes, type Box } from '../src/media/fmp4.js'
import { run } from './support/run.js'

let fixture: string, session: TranscodeSession, outDir: string

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

// media_time de las entradas del elst de un trak (o [] si no tiene edts). El
// trim del retardo del códec sobrevive a canonicalizeInit (no depende del
// run), así que un `edts` presente no es, por sí solo, prueba de nada; lo que
// no puede sobrevivir es una entrada con media_time==-1 (el empty edit que
// memoriza dónde arrancó ESE proceso).
function elstMediaTimes(buf: Buffer, trak: Box): number[] {
  const edtsBox = parseBoxes(buf, trak.start + trak.hdr, trak.start + trak.size).find(b => b.type === 'edts')
  if (!edtsBox) return []
  const elst = parseBoxes(buf, edtsBox.start + edtsBox.hdr, edtsBox.start + edtsBox.size)[0]
  const version = buf[elst.start + elst.hdr]
  const count = buf.readUInt32BE(elst.start + elst.hdr + 4)
  const entrySize = version === 1 ? 20 : 12
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const at = elst.start + elst.hdr + 8 + i * entrySize
    out.push(version === 1 ? Number(buf.readBigInt64BE(at + 8)) : buf.readInt32BE(at + 4))
  }
  return out
}

// start_time de cada pista de un fMP4, que solo es reproducible con su init
// delante. Es la medida que importa: es donde hls.js coloca el segmento.
async function startTimes(dir: string, init: Buffer, seg: Buffer): Promise<number[]> {
  const joined = join(dir, `joined-${randomBytes(4).toString('hex')}.mp4`)
  writeFileSync(joined, Buffer.concat([init, seg]))
  const { stdout } = await run(ffprobeStatic.path, [
    '-v', 'error', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', joined,
  ])
  return stdout.trim().split('\n').map(Number)
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-'))
  fixture = await makeFixtureMkv(dir, { seconds: 30, withSubs: false })
  outDir = join(dir, 'out'); mkdirSync(outDir)
  const info = await probeFile(fixture)
  const kf = await extractKeyframes(fixture)
  session = new TranscodeSession({
    input: fixture, mode: 'copy', encoder: 'libx264',
    segments: planSegments(info.durationSec, kf), audioCount: 2, outDir,
  })
})
afterAll(async () => { await session?.stop() })

describe('TranscodeSession', () => {
  it('produces early video and audio segments', async () => {
    session.start()
    const v0 = await session.requestSegment(0, 0)
    expect(existsSync(v0)).toBe(true)
    expect(existsSync(await session.requestSegment(1, 0))).toBe(true)
    expect(existsSync(await session.requestSegment(2, 1))).toBe(true)
    expect(existsSync(join(outDir, 'init_0.mp4'))).toBe(true)
  })

  it('requesting a segment behind the current start forces a genuine seekTo restart', async () => {
    // Starting session.start() at 0 and later asking for a late segment never
    // exercises seekTo(): a "copy"-mode remux of the 30s fixture finishes
    // almost instantly, so by the time the later segment is requested it is
    // already on disk from the original process. To force a real kill+restart
    // we start a fresh session at a mid segment and then ask for an earlier
    // one that the mid-start process can never produce on its own (it only
    // encodes forward from its -ss point), which must trigger seekTo().
    const segments = session['segments']
    const midIndex = Math.floor(segments.length / 2)
    const earlierIndex = 1 // != 0, so success also proves -start_number isn't just defaulting to 0
    expect(earlierIndex).toBeLessThan(midIndex)

    const seekOutDir = join(mkdtempSync(join(tmpdir(), 'tsc-seek-')), 'out')
    mkdirSync(seekOutDir)
    const seekSession = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264', segments, audioCount: 2, outDir: seekOutDir,
    })
    const seekSpy = vi.spyOn(seekSession, 'seekTo')

    seekSession.start(midIndex)
    await seekSession.requestSegment(0, midIndex, 20_000)
    const oldProc = seekSession['proc']
    expect(oldProc).not.toBeNull()

    const earlierPath = join(seekOutDir, `seg_0_${String(earlierIndex).padStart(5, '0')}.m4s`)
    expect(existsSync(earlierPath)).toBe(false) // the mid-start process never produces this

    const p = await seekSession.requestSegment(0, earlierIndex, 45_000)

    expect(seekSpy).toHaveBeenCalledWith(earlierIndex) // seekTo genuinely ran
    expect(p).toBe(earlierPath) // restarted numbering at earlierIndex via -start_number
    expect(existsSync(p)).toBe(true)
    expect(seekSession['proc']).not.toBe(oldProc) // old process was replaced
    // The old process is dead either because seekTo SIGKILLed it or because a
    // fast copy-mode remux finished on its own before the seek arrived — both
    // are valid; asserting killed===true races against ffmpeg's own exit.
    expect(oldProc?.killed || oldProc?.exitCode !== null || oldProc?.signalCode !== null).toBe(true)

    await seekSession.stop()
  }, 90_000)

  it('seekTo into an already-cached segment keeps the current process (no restart)', async () => {
    // Restarting ffmpeg over a cached region would regenerate segments that are
    // already servable and rewrite init_*.mp4 under clients' feet, so a seek
    // whose target (every variant) is ready must leave the process alone.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-cached-'))
    const cachedOutDir = join(dir, 'out'); mkdirSync(cachedOutDir)
    const cachedSession = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264',
      segments: session['segments'], audioCount: 2, outDir: cachedOutDir,
    })
    cachedSession.start()
    for (const variant of [0, 1, 2]) await cachedSession.requestSegment(variant, 1, 20_000)
    const proc = cachedSession['proc']
    expect(proc).not.toBeNull()

    cachedSession.seekTo(1)
    expect(cachedSession['proc']).toBe(proc)

    await cachedSession.stop()
  }, 60_000)

  it('seekTo to the segment the live process already started from does not restart it', async () => {
    // Vídeo y audio piden el mismo índice: si cada petición reiniciara ffmpeg,
    // se matarían entre sí en bucle y no se produciría nunca ese segmento.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-same-'))
    const sameOutDir = join(dir, 'out'); mkdirSync(sameOutDir)
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264', segments, audioCount: 2, outDir: sameOutDir,
    })
    s.start(mid)
    const proc = s['proc']
    expect(proc).not.toBeNull()

    s.seekTo(mid)
    expect(s['proc']).toBe(proc)

    await s.stop()
  }, 60_000)

  it('a segment far ahead of the working point restarts ffmpeg there instead of timing out', async () => {
    // Sin esto, el cliente espera los 30 s completos a un segmento que nadie
    // está produciendo y acaba en 504.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-fwd-'))
    const fwdOutDir = join(dir, 'out'); mkdirSync(fwdOutDir)
    const segments = session['segments']
    const late = segments.length - 1
    expect(late).toBeGreaterThan(1)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264', segments, audioCount: 2, outDir: fwdOutDir,
    })
    const seekSpy = vi.spyOn(s, 'seekTo')
    s.start(0)
    // Se mata el proceso a mano para que nadie avance hacia `late`: es la
    // situación real en la que ffmpeg quedó muy por detrás del reloj de sala.
    s['proc']?.kill('SIGKILL')
    await new Promise(r => setTimeout(r, 300))

    const p = await s.requestSegment(0, late, 45_000)
    expect(seekSpy).toHaveBeenCalledWith(late)
    expect(existsSync(p)).toBe(true)

    await s.stop()
  }, 90_000)

  it('stop() closes the session so later start()/seekTo() calls no-op instead of respawning ffmpeg', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsc-closed-'))
    const closedOutDir = join(dir, 'out'); mkdirSync(closedOutDir)
    const info = await probeFile(fixture)
    const kf = await extractKeyframes(fixture)
    const closedSession = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264',
      segments: planSegments(info.durationSec, kf), audioCount: 2, outDir: closedOutDir,
    })
    closedSession.start()
    await closedSession.requestSegment(0, 0)
    expect(closedSession['proc']).not.toBeNull()

    await closedSession.stop()
    expect(closedSession['proc']).toBeNull()

    closedSession.seekTo(1)
    expect(closedSession['proc']).toBeNull() // no respawn: closed session ignores seekTo()

    closedSession.start(0)
    expect(closedSession['proc']).toBeNull() // no respawn: closed session ignores start()
  })

  it('requestInit hands out a snapshot that survives ffmpeg rewriting the live init file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsc-init-'))
    const initOutDir = join(dir, 'out'); mkdirSync(initOutDir)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264',
      segments: session['segments'], audioCount: 2, outDir: initOutDir,
    })
    s.start()
    const p = await s.requestInit(0, 30_000)
    expect(p).toBe(join(initOutDir, 'init_0.stable.mp4'))
    const snapshot = readFileSync(p)
    expect(snapshot.length).toBeGreaterThan(0)

    // Simula el reinicio de ffmpeg dejando el init vivo a medio escribir: el
    // snapshot ya entregado no puede verse afectado.
    writeFileSync(join(initOutDir, 'init_0.mp4'), Buffer.alloc(3))
    expect(await s.requestInit(0, 5_000)).toBe(p)
    expect(readFileSync(p).equals(snapshot)).toBe(true)

    await s.stop()
  }, 60_000)

  it('el init entregado es canónico y no depende del run que lo produjo', async () => {
    // El fallo de bb67bc0: ffmpeg guarda en el edts del init la posición donde
    // arrancó ESE proceso, y el servidor fija un init para toda la sala. Si el
    // init recuerda su run, los segmentos de cualquier otro reinicio se colocan
    // en el offset equivocado.
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const paths: string[] = []
    for (const [name, from] of [['desde0', 0], ['mid', mid]] as const) {
      const dir = mkdtempSync(join(tmpdir(), `tsc-canon-${name}-`))
      const out = join(dir, 'out'); mkdirSync(out)
      // audioCount 1 → una sola variante con el audio DENTRO del segmento de
      // vídeo (ver hlsLayout.ts), que es la forma en que corre una sala normal y
      // la única en la que el init 0 tiene dos pistas que comprobar.
      const s = new TranscodeSession({
        input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 1, outDir: out,
      })
      s.start(from)
      paths.push(await s.requestInit(0, 30_000))
      await s.stop()
    }

    const [desde0, desdeMid] = paths.map(p => readFileSync(p))
    // Ningún trak conserva el empty edit (media_time==-1) del -ss. El edts en
    // sí puede sobrevivir: el trim del retardo del códec no depende del run
    // y hay que conservarlo para que retimeHeader clave el tfdt sin dejar el
    // vídeo sistemáticamente tarde (ver canonicalizeInit en fmp4.ts).
    const moov = parseBoxes(desde0).find(b => b.type === 'moov')!
    for (const t of parseBoxes(desde0, moov.start + moov.hdr, moov.start + moov.size)) {
      if (t.type !== 'trak') continue
      expect(elstMediaTimes(desde0, t)).not.toContain(-1)
    }
    // Y los dos runs dan exactamente el mismo init.
    expect(desdeMid.equals(desde0)).toBe(true)
  }, 120_000)

  it('un segmento de un run reiniciado aterriza en su sitio con el init de OTRO run', async () => {
    // Exactamente el fallo reportado en bb67bc0: la sala arranca en 0, fija ese
    // init, el host salta a mitad de película y ffmpeg reinicia. Medido antes de
    // este arreglo: el segmento decodificaba en 0:00:00 en vez de en su minuto.
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)

    const dirA = mkdtempSync(join(tmpdir(), 'tsc-open-a-'))
    const outA = join(dirA, 'out'); mkdirSync(outA)
    // audioCount 1 → el audio va dentro del segmento de vídeo, así que
    // startTimes() devuelve las dos pistas y de paso comprueba el lipsync.
    const a = new TranscodeSession({
      input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 1, outDir: outA,
    })
    a.start(0)
    const initFijado = readFileSync(await a.requestInit(0, 30_000))
    await a.stop()

    const dirB = mkdtempSync(join(tmpdir(), 'tsc-open-b-'))
    const outB = join(dirB, 'out'); mkdirSync(outB)
    const b = new TranscodeSession({
      input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 1, outDir: outB,
    })
    b.start(mid)
    const seg = await drain(await b.openSegment(0, mid, 30_000))
    await b.stop()

    // El init es el del run A y el segmento el del run B: es el cruce que rompía.
    const times = await startTimes(dirB, initFijado, seg)
    expect(times).toHaveLength(2) // vídeo y audio, los dos dentro del segmento
    for (const t of times) {
      expect(Math.abs(t - segments[mid].start)).toBeLessThan(0.05)
    }
  }, 120_000)

  it('a segment produced by a mid-film start carries the correct absolute timestamp', async () => {
    // Si el tfdt del segmento no coincide con lo que dice la playlist, hls.js lo
    // bufferiza en el sitio equivocado: el vídeo no aparece pero los subtítulos,
    // que son <track> nativos guiados por currentTime, sí siguen pintándose.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-'))
    const tsOutDir = join(dir, 'out'); mkdirSync(tsOutDir)
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const s = new TranscodeSession({
      input: fixture, mode: 'copy', encoder: 'libx264', segments, audioCount: 2, outDir: tsOutDir,
    })
    s.start(mid)
    const seg = await drain(await s.openSegment(0, mid, 30_000))
    const init = readFileSync(await s.requestInit(0, 30_000))

    // openSegment ancla el segmento al límite que declara la playlist, así que
    // el margen deja de ser «casi» y pasa a ser exacto salvo redondeo.
    const [video] = await startTimes(dir, init, seg)
    expect(Math.abs(video - segments[mid].start)).toBeLessThan(0.05)
    await s.stop()
  }, 90_000)

  it('a segment produced by a mid-film start in TRANSCODE mode carries the correct absolute timestamp', async () => {
    // Same measurement, transcode mode: -ss must be seg.start (the boundary),
    // not seg.seekAt (the copy-mode keyframe midpoint), or the first output
    // frame lands half a GOP late — invisible in copy mode because ffmpeg
    // there can't discard frames, but a real regression in transcode mode
    // where it decodes and discards up to whatever instant -ss names.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-ts-transcode-'))
    const tsOutDir = join(dir, 'out'); mkdirSync(tsOutDir)
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const s = new TranscodeSession({
      input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 2, outDir: tsOutDir,
    })
    s.start(mid)
    const seg = await drain(await s.openSegment(0, mid, 30_000))
    const init = readFileSync(await s.requestInit(0, 30_000))

    // openSegment ancla el segmento al límite que declara la playlist, así que
    // el margen deja de ser «casi» y pasa a ser exacto salvo redondeo.
    const [video] = await startTimes(dir, init, seg)
    expect(Math.abs(video - segments[mid].start)).toBeLessThan(0.05)
    await s.stop()
  }, 90_000)

  it('a mid-film restart in transcode mode cuts the segment at the planned 4s boundary, not x264\'s default keyint', async () => {
    // `t` en -force_key_frames es relativo al punto de -ss, incluso con
    // -copyts: si la expresión queda anclada a seg.start nunca se satisface,
    // x264 cae a su keyint por defecto (~10 s a 24 fps) y el segmento
    // producido desborda lo que la playlist (planSegments, objetivo 4 s) dice.
    const dir = mkdtempSync(join(tmpdir(), 'tsc-kf-'))
    const kfOutDir = join(dir, 'out'); mkdirSync(kfOutDir)
    const segments = session['segments']
    const mid = Math.floor(segments.length / 2)
    const s = new TranscodeSession({
      input: fixture, mode: 'transcode', encoder: 'libx264', segments, audioCount: 2, outDir: kfOutDir,
    })
    s.start(mid)
    const segPath = await s.requestSegment(0, mid, 60_000)
    const initPath = await s.requestInit(0, 30_000)

    const joined = join(dir, 'joined.mp4')
    writeFileSync(joined, Buffer.concat([readFileSync(initPath), readFileSync(segPath)]))
    const { stdout } = await run(ffprobeStatic.path, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'format=duration', '-of', 'csv=p=0', joined,
    ])

    expect(Math.abs(Number(stdout.trim()) - segments[mid].duration)).toBeLessThan(1.5)
    await s.stop()
  }, 90_000)
})
