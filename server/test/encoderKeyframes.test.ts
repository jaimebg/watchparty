import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { makeFixtureMkv } from './support/fixture.js'
import { run } from './support/run.js'
import { buildTranscodeArgs } from '../src/media/ffmpegArgs.js'
import { planSegments } from '../src/media/planner.js'

// El contrato que vigila este archivo está escrito entero en hlsLayout.ts: la
// playlist es VOD, así que el servidor declara los cortes DE ANTEMANO desde
// planSegments, y `openSegment` reancla la cabecera de cada segmento al
// instante que esa playlist ya declaró. Nada de eso es correcto si ffmpeg no
// corta donde el plan dice, y quien decide si corta ahí es el ENCODER: es él
// quien tiene que obedecer a -force_key_frames.
//
// Y no todos obedecen. Medido con este ffmpeg sobre un fuente a 24 fps:
// h264_nvenc ignoraba -force_key_frames y caía a su GOP por defecto (250
// fotogramas = 10,427 s), de modo que la playlist declaraba el segmento i en
// 4i mientras el archivo contenía lo que empieza en 10,427i — una desviación
// que crece sin techo. libx264 obedecía. El fallo era, por tanto, invisible en
// macOS (VideoToolbox) y en cualquier test que solo mirase libx264: solo
// aparecía en Windows con GPU NVIDIA, que es justo donde parseEncoders elige
// h264_nvenc.
//
// Por eso este test no comprueba flags: ejecuta el ffmpeg de verdad con los
// args de producción y mide los cortes que salen, con CADA encoder que
// funcione en la máquina que corra los tests. Es la única forma de que la
// próxima incorporación (h264_amf, un qsv nuevo, lo que venga) no repita el
// mismo fallo en silencio.

const FF = ffmpegPath as unknown as string
const FPS = 24
// El GOP por defecto de NVENC son 250 fotogramas: a 24 fps, 10,4 s. El fuente
// tiene que durar bastante más que eso, o un encoder desobediente cabría en un
// solo segmento y la desviación no se vería. Y no debe caer justo en un límite
// de la rejilla: ahí ffmpeg cierra además un segmento residual de un fotograma
// que no es ningún fallo, solo el final del fuente.
const SECONDS = 22
const SEGMENTS = planSegments(SECONDS, null)

// Los candidatos son exactamente los que parseEncoders() puede devolver.
const CANDIDATES = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_videotoolbox']

let dir: string, fixture: string, usable: string[]

// Que `ffmpeg -encoders` liste un encoder no prueba que la máquina pueda
// usarlo: el binario empaquetado lista h264_nvenc y h264_qsv siempre, tenga o
// no la GPU delante. La única prueba es codificar algo. Un encoder que no
// arranca aquí se salta (no es un fallo de esta máquina); uno que arranca se
// mide, y ahí sí, cortar donde no toca es un fallo.
async function encodes(encoder: string): Promise<boolean> {
  try {
    await run(FF, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${FPS}:duration=1`,
      '-c:v', encoder, '-f', 'null', '-'])
    return true
  } catch {
    return false
  }
}

/**
 * Los instantes en los que ffmpeg cortó de verdad, acumulando los EXTINF de la
 * playlist que él mismo escribe.
 *
 * Se miden los CORTES y no las duraciones porque es el corte lo que tiene que
 * coincidir con el plan: `openSegment` reancla cada segmento a `segments[i].start`,
 * así que un corte en otro sitio es material servido bajo un instante que no es
 * el suyo. Además así el final del fuente no ensucia la medida: da igual cuánto
 * dure el último trozo, solo importa dónde empezó.
 */
function cutPoints(playlist: string): number[] {
  const cuts: number[] = []
  let t = 0
  for (const m of playlist.matchAll(/#EXTINF:([\d.]+)/g)) { t += Number(m[1]); cuts.push(t) }
  return cuts.slice(0, -1) // el último no es un corte, es el final del fuente
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jbg-enc-'))
  fixture = await makeFixtureMkv(dir, { seconds: SECONDS, withSubs: false, audioTracks: 1 })
  usable = []
  for (const e of CANDIDATES) if (await encodes(e)) usable.push(e)
}, 180_000)

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('los cortes que produce el encoder son los que la playlist declara', () => {
  it('libx264 está disponible siempre: sin él, el resto del archivo no probaría nada', () => {
    expect(usable).toContain('libx264')
  })

  // Un `it` por encoder no se puede generar aquí (la lista se descubre en
  // beforeAll, después de que vitest haya recogido los tests), así que se
  // recorren dentro y el fallo nombra al culpable.
  it('cada encoder utilizable corta en la rejilla de planSegments', async () => {
    // Los cortes que la playlist del servidor declara: el arranque de cada
    // segmento menos el del primero, que no es un corte sino el origen.
    const esperado = SEGMENTS.slice(1).map(s => s.start)
    const fallos: string[] = []

    for (const encoder of usable) {
      const outDir = join(dir, `out-${encoder}`)
      mkdirSync(outDir, { recursive: true })
      // Los args de producción tal cual: si buildTranscodeArgs cambia, este
      // test se entera. Reconstruirlos a mano aquí sería medir otra cosa.
      const args = buildTranscodeArgs({
        input: fixture, mode: 'transcode', encoder,
        startSegment: 0, segments: SEGMENTS, audioCount: 1, outDir,
      })
      await run(FF, args)
      const real = cutPoints(readFileSync(join(outDir, 'ffm_0.m3u8'), 'utf8'))

      const desviado = esperado.find((e, i) => real[i] === undefined || Math.abs(real[i] - e) > 0.2)
      if (desviado !== undefined) {
        fallos.push(`${encoder}: la playlist declara cortes en [${esperado.join(', ')}] `
          + `y ffmpeg cortó en [${real.map(c => c.toFixed(3)).join(', ')}]`)
      }
    }

    expect(fallos, `encoders probados: ${usable.join(', ')}`).toEqual([])
  }, 180_000)
})
