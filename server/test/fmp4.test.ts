import { describe, it, expect } from 'vitest'
import { parseBoxes, headerLength, canonicalizeInit } from '../src/media/fmp4.js'

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

// elst con un empty edit (media_time = -1): lo que ffmpeg escribe tras un -ss.
function edts(emptyEditDuration: number): Buffer {
  const p = Buffer.alloc(16)
  p.writeUInt32BE(1, 4)                 // entry_count
  p.writeUInt32BE(emptyEditDuration, 8) // segment_duration
  p.writeInt32BE(-1, 12)                // media_time
  return box('edts', box('elst', p))
}

const trak = (id: number, ts: number) =>
  box('trak', Buffer.concat([tkhd(id, 4000), edts(20000), box('mdia', mdhd(ts, 4000))]))

const fakeInit = () => Buffer.concat([
  box('ftyp', Buffer.alloc(8)),
  box('moov', Buffer.concat([mvhd(1000, 4000), trak(1, 12800), trak(2, 44100)])),
])

describe('canonicalizeInit', () => {
  it('quita el edts de cada pista y arregla los tamaños de trak y moov', () => {
    const { init } = canonicalizeInit(fakeInit())
    const moov = parseBoxes(init).find(b => b.type === 'moov')!
    const traks = parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    expect(traks).toHaveLength(2)
    for (const t of traks) {
      expect(parseBoxes(init, t.start + t.hdr, t.start + t.size).map(b => b.type)).toEqual(['tkhd', 'mdia'])
    }
    // Los tamaños tienen que cuadrar de verdad: si moov mintiera, parseBoxes
    // del nivel superior no llegaría hasta el final del buffer.
    expect(parseBoxes(init).map(b => b.type)).toEqual(['ftyp', 'moov'])
    expect(moov.start + moov.size).toBe(init.length)
  })

  it('devuelve el timescale de cada pista', () => {
    expect([...canonicalizeInit(fakeInit()).timescales]).toEqual([[1, 12800], [2, 44100]])
  })

  it('pone a cero las duraciones, para que dos runs distintos den el mismo init', () => {
    const desde0 = canonicalizeInit(fakeInit()).init
    // Un run reiniciado codifica menos metraje: otras duraciones y otro empty edit.
    const otro = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.concat([
        mvhd(1000, 999), box('trak', Buffer.concat([tkhd(1, 111), edts(77), box('mdia', mdhd(12800, 111))])),
        box('trak', Buffer.concat([tkhd(2, 222), edts(88), box('mdia', mdhd(44100, 222))])),
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

  it('es idempotente: canonicalizar un init ya canónico no lo cambia', () => {
    const una = canonicalizeInit(fakeInit()).init
    expect(canonicalizeInit(una).init.equals(una)).toBe(true)
  })
})
