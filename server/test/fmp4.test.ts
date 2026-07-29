import { describe, it, expect } from 'vitest'
import { parseBoxes, headerLength, canonicalizeInit, retimeHeader, type Box } from '../src/media/fmp4.js'

// Construye una caja MP4: [size:4][type:4][payload]
function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + payload.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

describe('parseBoxes', () => {
  it('lista las cajas de nivel superior con su offset y tamaño', () => {
    const buf = Buffer.concat([box('ftyp', Buffer.alloc(4)), box('moov', Buffer.alloc(16))])
    expect(parseBoxes(buf)).toEqual([
      { type: 'ftyp', start: 0, hdr: 8, size: 12 },
      { type: 'moov', start: 12, hdr: 8, size: 24 },
    ])
  })

  it('recorre solo el rango pedido, para bajar a los hijos de un contenedor', () => {
    const inner = Buffer.concat([box('mvhd', Buffer.alloc(4))])
    const buf = box('moov', inner)
    const [moov] = parseBoxes(buf)
    expect(parseBoxes(buf, moov.start + moov.hdr, moov.start + moov.size).map(b => b.type)).toEqual(['mvhd'])
  })

  it('entiende el tamaño de 64 bits (size==1)', () => {
    const buf = Buffer.alloc(20)
    buf.writeUInt32BE(1, 0)
    buf.write('mdat', 4, 'latin1')
    buf.writeBigUInt64BE(20n, 8)
    expect(parseBoxes(buf)).toEqual([{ type: 'mdat', start: 0, hdr: 16, size: 20 }])
  })

  it('para en seco ante una caja que se sale del buffer en vez de leer basura', () => {
    const truncated = box('moov', Buffer.alloc(40)).subarray(0, 20)
    expect(parseBoxes(truncated)).toEqual([])
  })
})

describe('headerLength', () => {
  it('devuelve el offset del mdat', () => {
    // styp=8, sidx=8+8=16, moof=8+4=12 → el mdat empieza en 36.
    const buf = Buffer.concat([box('styp'), box('sidx', Buffer.alloc(8)), box('moof', Buffer.alloc(4)), box('mdat', Buffer.alloc(9))])
    expect(headerLength(buf)).toBe(36)
  })

  it('encuentra el mdat aunque su contenido NO quepa en el buffer', () => {
    // Es el caso real: se leen 64 KB de un segmento de megas, así que el mdat
    // declara un tamaño que se sale del buffer. Si se exigiera que la caja
    // entera quepa, nunca se encontraría la cabecera.
    const head = Buffer.concat([box('styp'), box('moof', Buffer.alloc(4))])
    const mdat = Buffer.alloc(8)
    mdat.writeUInt32BE(5_000_000, 0)
    mdat.write('mdat', 4, 'latin1')
    expect(headerLength(Buffer.concat([head, mdat]))).toBe(head.length)
  })

  it('devuelve -1 si el mdat no aparece dentro del buffer', () => {
    expect(headerLength(Buffer.concat([box('styp'), box('sidx', Buffer.alloc(8))]))).toBe(-1)
  })
})

// version(1)+flags(3), creation(4), modification(4), timescale(4), duration(4)
function mvhd(timescale: number, duration: number): Buffer {
  const p = Buffer.alloc(100)
  p.writeUInt32BE(timescale, 12)
  p.writeUInt32BE(duration, 16)
  return box('mvhd', p)
}

// version(1)+flags(3), creation(4), modification(4), trackID(4), reserved(4), duration(4)
function tkhd(trackId: number, duration: number): Buffer {
  const p = Buffer.alloc(80)
  p.writeUInt32BE(trackId, 12)
  p.writeUInt32BE(duration, 20)
  return box('tkhd', p)
}

// version(1)+flags(3), creation(4), modification(4), timescale(4), duration(4)
function mdhd(timescale: number, duration: number): Buffer {
  const p = Buffer.alloc(20)
  p.writeUInt32BE(timescale, 12)
  p.writeUInt32BE(duration, 16)
  return box('mdhd', p)
}

// elst con las entradas dadas, cada una [duration, mediaTime]. media_time=-1
// es el empty edit que ffmpeg escribe tras un -ss (depende del run, se tira
// en canonicalizeInit); cualquier otro media_time es el trim del retardo del
// códec (igual en todos los runs, se conserva verbatim). Versión 0 siempre,
// que es lo que escribe ffmpeg en la práctica (medido).
function edts(entries: [number, number][]): Buffer {
  const p = Buffer.alloc(8 + entries.length * 12)
  p.writeUInt32BE(entries.length, 4) // entry_count
  entries.forEach(([duration, mediaTime], i) => {
    const at = 8 + i * 12
    p.writeUInt32BE(duration, at)
    p.writeInt32BE(mediaTime, at + 4)
    // media_rate_integer/fraction quedan a 0, como los escribe ffmpeg.
  })
  return box('edts', box('elst', p))
}

// elst v1 (64 bits): mismo layout que v0 pero con duration/mediaTime de 8
// bytes cada uno. Nunca lo hemos visto escrito por ffmpeg, pero el formato lo
// permite y rebuildElst tiene que respetarlo sin cambiar la versión de la caja.
function edtsV1(entries: [number, number][]): Buffer {
  const p = Buffer.alloc(8 + entries.length * 20)
  p.writeUInt8(1, 0) // version
  p.writeUInt32BE(entries.length, 4)
  entries.forEach(([duration, mediaTime], i) => {
    const at = 8 + i * 20
    p.writeBigUInt64BE(BigInt(duration), at)
    p.writeBigInt64BE(BigInt(mediaTime), at + 8)
  })
  return box('edts', box('elst', p))
}

// Entradas [duration, mediaTime] del elst de un trak ya canonicalizado (o no).
function readElst(buf: Buffer, t: Box): [number, number][] {
  const edtsBox = parseBoxes(buf, t.start + t.hdr, t.start + t.size).find(b => b.type === 'edts')
  if (!edtsBox) return []
  const elst = parseBoxes(buf, edtsBox.start + edtsBox.hdr, edtsBox.start + edtsBox.size)[0]
  const version = buf[elst.start + elst.hdr]
  const count = buf.readUInt32BE(elst.start + elst.hdr + 4)
  const entrySize = version === 1 ? 20 : 12
  const out: [number, number][] = []
  for (let i = 0; i < count; i++) {
    const at = elst.start + elst.hdr + 8 + i * entrySize
    const duration = version === 1 ? Number(buf.readBigUInt64BE(at)) : buf.readUInt32BE(at)
    const mediaTime = version === 1 ? Number(buf.readBigInt64BE(at + 8)) : buf.readInt32BE(at + 4)
    out.push([duration, mediaTime])
  }
  return out
}

// El trim del códec (medido con libx264: 1024 en timescale de vídeo) no
// depende del run, así que el mismo valor aparece en fakeInit() y en `otro`
// más abajo: es lo que hace falta para que la comparación de reproducibilidad
// tenga sentido con el elst de dos entradas real, no con el edts-de-un-solo-
// empty-edit que se usaba antes de este arreglo.
const TRIM: [number, number] = [0, 1024]

const trak = (id: number, ts: number, emptyEditDuration: number) =>
  box('trak', Buffer.concat([
    tkhd(id, 4000), edts([[emptyEditDuration, -1], TRIM]), box('mdia', mdhd(ts, 4000)),
  ]))

const fakeInit = () => Buffer.concat([
  box('ftyp', Buffer.alloc(8)),
  box('moov', Buffer.concat([mvhd(1000, 4000), trak(1, 12800, 20000), trak(2, 44100, 20000)])),
])

describe('canonicalizeInit', () => {
  it('quita del elst solo las entradas de empty edit y arregla los tamaños de edts/trak/moov', () => {
    const { init } = canonicalizeInit(fakeInit())
    const moov = parseBoxes(init).find(b => b.type === 'moov')!
    const traks = parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    expect(traks).toHaveLength(2)
    for (const t of traks) {
      // El edts sobrevive porque le queda el trim: el orden de cajas no cambia.
      expect(parseBoxes(init, t.start + t.hdr, t.start + t.size).map(b => b.type)).toEqual(['tkhd', 'edts', 'mdia'])
      // Y lo que queda dentro es EXACTAMENTE el trim, verbatim, no el empty edit.
      expect(readElst(init, t)).toEqual([TRIM])
    }
    // Los tamaños tienen que cuadrar de verdad: si moov mintiera, parseBoxes
    // del nivel superior no llegaría hasta el final del buffer.
    expect(parseBoxes(init).map(b => b.type)).toEqual(['ftyp', 'moov'])
    expect(moov.start + moov.size).toBe(init.length)
  })

  it('un elst con solo un trim (sin empty edit) sobrevive intacto', () => {
    const soloTrim = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.concat([mvhd(1000, 4000),
        box('trak', Buffer.concat([tkhd(1, 4000), edts([TRIM]), box('mdia', mdhd(12800, 4000))]))])),
    ])
    const { init } = canonicalizeInit(soloTrim)
    const moov = parseBoxes(init).find(b => b.type === 'moov')!
    const [t] = parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    expect(parseBoxes(init, t.start + t.hdr, t.start + t.size).map(b => b.type)).toEqual(['tkhd', 'edts', 'mdia'])
    expect(readElst(init, t)).toEqual([TRIM])
    // La cascada de tamaños (elst→edts→trak→moov) tiene que cuadrar de verdad.
    expect(moov.start + moov.size).toBe(init.length)
  })

  it('un elst con solo empty edits desaparece por completo, junto con su edts', () => {
    const soloEmptyEdit = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.concat([mvhd(1000, 4000),
        box('trak', Buffer.concat([tkhd(1, 4000), edts([[20000, -1]]), box('mdia', mdhd(12800, 4000))]))])),
    ])
    const { init } = canonicalizeInit(soloEmptyEdit)
    const moov = parseBoxes(init).find(b => b.type === 'moov')!
    const [t] = parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    expect(parseBoxes(init, t.start + t.hdr, t.start + t.size).map(b => b.type)).toEqual(['tkhd', 'mdia'])
    // Tirar el edts entero también tiene que cuadrar la cascada de tamaños.
    expect(moov.start + moov.size).toBe(init.length)
  })

  it('funciona igual con un elst de versión 1 (64 bits), sin promocionar la versión', () => {
    const v1 = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.concat([mvhd(1000, 4000),
        box('trak', Buffer.concat([tkhd(1, 4000), edtsV1([[20000, -1], TRIM]), box('mdia', mdhd(12800, 4000))]))])),
    ])
    const { init } = canonicalizeInit(v1)
    const moov = parseBoxes(init).find(b => b.type === 'moov')!
    const [t] = parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    const edtsBox = parseBoxes(init, t.start + t.hdr, t.start + t.size).find(b => b.type === 'edts')!
    const elst = parseBoxes(init, edtsBox.start + edtsBox.hdr, edtsBox.start + edtsBox.size)[0]
    expect(init[elst.start + elst.hdr]).toBe(1) // sigue siendo v1
    expect(readElst(init, t)).toEqual([TRIM])
    // Esta es la única cobertura de la aritmética de entradas de 20 bytes
    // (v1): si saliera corta, parseBoxes seguiría encontrando el trak igual,
    // así que hace falta comprobar la cascada de tamaños explícitamente.
    expect(moov.start + moov.size).toBe(init.length)
  })

  it('un elst con entry_count inflado no lee más allá de su propio tamaño declarado', () => {
    // entry_count dice 4, pero la caja solo está dimensionada para 2
    // entradas reales (24 bytes de payload tras el prólogo de 8, dentro de
    // un elst de tamaño 40 = hdr 8 + 8 + 24). Sin acotar, el bucle seguiría
    // leyendo 2 "entradas" más de los bytes que vienen justo después del
    // elst dentro del trak: el mdia siguiente.
    const prologueMentiroso = Buffer.alloc(8)
    prologueMentiroso.writeUInt32BE(4, 4) // entry_count MIENTE: dice 4, caben 2
    const entradasReales = Buffer.concat([[20000, -1], TRIM].map(([dur, mediaTime]) => {
      const e = Buffer.alloc(12)
      e.writeUInt32BE(dur, 0)
      e.writeInt32BE(mediaTime, 4)
      return e
    }))
    const elstMentiroso = box('elst', Buffer.concat([prologueMentiroso, entradasReales])) // size real = 40
    const trakBuf = Buffer.concat([
      tkhd(1, 4000), box('edts', elstMentiroso), box('mdia', mdhd(12800, 4000)),
    ])
    const conMentira = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.concat([mvhd(1000, 4000), box('trak', trakBuf)])),
    ])
    const { init, timescales } = canonicalizeInit(conMentira)
    const moov = parseBoxes(init).find(b => b.type === 'moov')!
    const [t] = parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    // El elst solo conserva lo que de verdad cabía en su tamaño declarado: el
    // trim real, no una entrada fantasma hecha de bytes del mdia siguiente.
    expect(readElst(init, t)).toEqual([TRIM])
    // Y el mdia sigue intacto: si el elst se hubiera tragado sus primeros
    // bytes, este timescale saldría corrompido o el trak ni se encontraría.
    expect([...timescales]).toEqual([[1, 12800]])
    expect(moov.start + moov.size).toBe(init.length)
  })

  it('devuelve el timescale de cada pista', () => {
    expect([...canonicalizeInit(fakeInit()).timescales]).toEqual([[1, 12800], [2, 44100]])
  })

  it('pone a cero las duraciones, para que dos runs distintos den el mismo init', () => {
    const desde0 = canonicalizeInit(fakeInit()).init
    // Un run reiniciado codifica menos metraje: otras duraciones y otro empty
    // edit. El trim del códec (TRIM) es el mismo en los dos runs, como en la
    // realidad, y tiene que sobrevivir idéntico a los dos lados.
    const otro = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.concat([
        mvhd(1000, 999), box('trak', Buffer.concat([tkhd(1, 111), edts([[77, -1], TRIM]), box('mdia', mdhd(12800, 111))])),
        box('trak', Buffer.concat([tkhd(2, 222), edts([[88, -1], TRIM]), box('mdia', mdhd(44100, 222))])),
      ])),
    ])
    expect(canonicalizeInit(otro).init.equals(desde0)).toBe(true)
  })

  it('no toca el buffer de entrada', () => {
    const raw = fakeInit()
    const copia = Buffer.from(raw)
    canonicalizeInit(raw)
    expect(raw.equals(copia)).toBe(true)
  })

  it('es idempotente: canonicalizar un init ya canónico no lo cambia, y no vuelve a tocar el trim', () => {
    const una = canonicalizeInit(fakeInit()).init
    const dos = canonicalizeInit(una).init
    expect(dos.equals(una)).toBe(true)
    // Explícito además del byte-a-byte: el trim sigue siendo el mismo tras
    // pasar dos veces, no algo que una segunda pasada pudiera recortar más.
    const moov = parseBoxes(dos).find(b => b.type === 'moov')!
    const [t] = parseBoxes(dos, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    expect(readElst(dos, t)).toEqual([TRIM])
  })
})

// tfdt v1: version(1)+flags(3), baseMediaDecodeTime(8)
function tfdt(base: number): Buffer {
  const p = Buffer.alloc(12)
  p.writeUInt8(1, 0)
  p.writeBigUInt64BE(BigInt(base), 4)
  return box('tfdt', p)
}

// tfhd: version(1)+flags(3), track_ID(4)
function tfhd(trackId: number): Buffer {
  const p = Buffer.alloc(8)
  p.writeUInt32BE(trackId, 4)
  return box('tfhd', p)
}

// sidx v1: version(1)+flags(3), reference_ID(4), timescale(4), earliestPT(8), firstOffset(8)
function sidx(trackId: number, timescale: number, earliest: number): Buffer {
  const p = Buffer.alloc(28)
  p.writeUInt8(1, 0)
  p.writeUInt32BE(trackId, 4)
  p.writeUInt32BE(timescale, 8)
  p.writeBigUInt64BE(BigInt(earliest), 12)
  return box('sidx', p)
}

const readTfdt = (buf: Buffer, nth = 0) =>
  Number(buf.readBigUInt64BE(parseBoxes(buf).filter(b => b.type === 'moof')
    .flatMap(m => parseBoxes(buf, m.start + m.hdr, m.start + m.size))
    .flatMap(t => parseBoxes(buf, t.start + t.hdr, t.start + t.size))
    .filter(b => b.type === 'tfdt')[nth].start + 12))

const readSidx = (buf: Buffer, nth = 0) =>
  Number(buf.readBigUInt64BE(parseBoxes(buf).filter(b => b.type === 'sidx')[nth].start + 20))

const SCALES = new Map([[1, 12800], [2, 44100]])

// Cabecera como la que escribe ffmpeg: styp, un sidx por pista, y un moof con
// un traf por pista. Un run reiniciado la escribe con los tfdt a cero.
const head = (videoBase: number, audioBase: number) => Buffer.concat([
  box('styp', Buffer.alloc(8)),
  sidx(1, 12800, videoBase),
  sidx(2, 44100, audioBase),
  box('moof', Buffer.concat([
    box('mfhd', Buffer.alloc(8)),
    box('traf', Buffer.concat([tfhd(1), tfdt(videoBase)])),
    box('traf', Buffer.concat([tfhd(2), tfdt(audioBase)])),
  ])),
])

describe('retimeHeader', () => {
  it('lleva el tfdt de cada pista a start × su propio timescale', () => {
    const out = retimeHeader(head(0, 0), SCALES, 20)
    expect(readTfdt(out, 0)).toBe(20 * 12800)
    expect(readTfdt(out, 1)).toBe(20 * 44100)
  })

  it('mueve también el earliest_presentation_time del sidx', () => {
    const out = retimeHeader(head(0, 0), SCALES, 20)
    expect(readSidx(out, 0)).toBe(20 * 12800)
    expect(readSidx(out, 1)).toBe(20 * 44100)
  })

  it('desplaza, no fija: un segundo fragmento conserva su separación', () => {
    const dos = Buffer.concat([
      head(0, 0),
      box('moof', Buffer.concat([
        box('mfhd', Buffer.alloc(8)),
        box('traf', Buffer.concat([tfhd(1), tfdt(2 * 12800)])),
        box('traf', Buffer.concat([tfhd(2), tfdt(2 * 44100)])),
      ])),
    ])
    const out = retimeHeader(dos, SCALES, 20)
    expect(readTfdt(out, 2)).toBe(22 * 12800)
    expect(readTfdt(out, 3)).toBe(22 * 44100)
  })

  it('funciona igual con un run que ya traía tiempos absolutos', () => {
    const out = retimeHeader(head(8 * 12800, 8 * 44100), SCALES, 20)
    expect(readTfdt(out, 0)).toBe(20 * 12800)
    expect(readTfdt(out, 1)).toBe(20 * 44100)
  })

  it('no cambia el tamaño del buffer ni toca la entrada', () => {
    const entrada = head(0, 0)
    const copia = Buffer.from(entrada)
    const out = retimeHeader(entrada, SCALES, 20)
    expect(out.length).toBe(entrada.length)
    expect(entrada.equals(copia)).toBe(true)
  })

  it('deja intacta una pista de la que no conoce el timescale', () => {
    const out = retimeHeader(head(0, 0), new Map([[1, 12800]]), 20)
    expect(readTfdt(out, 0)).toBe(20 * 12800)
    expect(readTfdt(out, 1)).toBe(0)
    expect(readSidx(out, 1)).toBe(0)
  })
})
