import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffprobeStatic from 'ffprobe-static'
import { makeFixtureMkv } from './support/fixture.js'
import { extractKeyframes, probeFile } from '../src/media/probe.js'
import { planSegments } from '../src/media/planner.js'
import { TranscodeSession } from '../src/media/transcoder.js'
import { run } from './support/run.js'

let fixture: string, session: TranscodeSession, outDir: string

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
    const segPath = await s.requestSegment(0, mid, 30_000)
    const initPath = await s.requestInit(0, 30_000)

    // Un fMP4 suelto no es reproducible: hay que anteponerle su init.
    const joined = join(dir, 'joined.mp4')
    writeFileSync(joined, Buffer.concat([readFileSync(initPath), readFileSync(segPath)]))
    const { stdout } = await run(ffprobeStatic.path, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=start_time', '-of', 'csv=p=0', joined,
    ])

    expect(Math.abs(Number(stdout.trim()) - segments[mid].start)).toBeLessThan(0.1)
    await s.stop()
  }, 90_000)
})
