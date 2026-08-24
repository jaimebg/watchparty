import { describe, it, expect } from 'vitest'
import { parseBoxes, headerLength, canonicalizeInit, retimeHeader, type Box } from '../src/media/fmp4.js'

// Builds an MP4 box: [size:4][type:4][payload]
function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + payload.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

describe('parseBoxes', () => {
  it('lists the top-level boxes with their offset and size', () => {
    const buf = Buffer.concat([box('ftyp', Buffer.alloc(4)), box('moov', Buffer.alloc(16))])
    expect(parseBoxes(buf)).toEqual([
      { type: 'ftyp', start: 0, hdr: 8, size: 12 },
      { type: 'moov', start: 12, hdr: 8, size: 24 },
    ])
  })

  it('walks only the requested range, so it can descend into a container\'s children', () => {
    const inner = Buffer.concat([box('mvhd', Buffer.alloc(4))])
    const buf = box('moov', inner)
    const [moov] = parseBoxes(buf)
    expect(parseBoxes(buf, moov.start + moov.hdr, moov.start + moov.size).map(b => b.type)).toEqual(['mvhd'])
  })

  it('understands the 64-bit size (size==1)', () => {
    const buf = Buffer.alloc(20)
    buf.writeUInt32BE(1, 0)
    buf.write('mdat', 4, 'latin1')
    buf.writeBigUInt64BE(20n, 8)
    expect(parseBoxes(buf)).toEqual([{ type: 'mdat', start: 0, hdr: 16, size: 20 }])
  })

  it('stops dead on a box that runs past the buffer instead of reading garbage', () => {
    const truncated = box('moov', Buffer.alloc(40)).subarray(0, 20)
    expect(parseBoxes(truncated)).toEqual([])
  })
})

describe('headerLength', () => {
  it('returns the mdat offset', () => {
    // styp=8, sidx=8+8=16, moof=8+4=12 → the mdat starts at 36.
    const buf = Buffer.concat([box('styp'), box('sidx', Buffer.alloc(8)), box('moof', Buffer.alloc(4)), box('mdat', Buffer.alloc(9))])
    expect(headerLength(buf)).toBe(36)
  })

  it('finds the mdat even when its content does NOT fit in the buffer', () => {
    // The real case: 64 KB is read from a segment of megabytes, so the mdat
    // declares a size that runs past the buffer. Requiring the whole box to fit
    // would mean never finding the header.
    const head = Buffer.concat([box('styp'), box('moof', Buffer.alloc(4))])
    const mdat = Buffer.alloc(8)
    mdat.writeUInt32BE(5_000_000, 0)
    mdat.write('mdat', 4, 'latin1')
    expect(headerLength(Buffer.concat([head, mdat]))).toBe(head.length)
  })

  it('returns -1 when the mdat does not appear inside the buffer', () => {
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

// An elst with the given entries, each [duration, mediaTime]. media_time=-1 is
// the empty edit ffmpeg writes after a -ss (run-dependent, dropped in
// canonicalizeInit); any other media_time is the codec delay trim (identical
// across runs, kept verbatim). Always version 0, which is what ffmpeg writes in
// practice (measured).
function edts(entries: [number, number][]): Buffer {
  const p = Buffer.alloc(8 + entries.length * 12)
  p.writeUInt32BE(entries.length, 4) // entry_count
  entries.forEach(([duration, mediaTime], i) => {
    const at = 8 + i * 12
    p.writeUInt32BE(duration, at)
    p.writeInt32BE(mediaTime, at + 4)
    // media_rate_integer/fraction stay at 0, the way ffmpeg writes them.
  })
  return box('edts', box('elst', p))
}

// elst v1 (64 bits): same layout as v0 but with 8-byte duration/mediaTime.
// We have never seen ffmpeg write one, but the format allows it and rebuildElst
// has to respect it without changing the box's version.
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

// The [duration, mediaTime] entries of a trak's elst, canonicalized or not.
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

// The codec trim (measured with libx264: 1024 in the video timescale) does not
// depend on the run, so the same value appears in fakeInit() and in `other`
// below: that is what makes the reproducibility comparison meaningful against a
// real two-entry elst, rather than the single-empty-edit edts used before this
// fix.
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
  it('removes only the empty-edit entries from the elst and fixes the edts/trak/moov sizes', () => {
    const { init } = canonicalizeInit(fakeInit())
    const moov = parseBoxes(init).find(b => b.type === 'moov')!
    const traks = parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    expect(traks).toHaveLength(2)
    for (const t of traks) {
      // The edts survives because the trim remains: box order does not change.
      expect(parseBoxes(init, t.start + t.hdr, t.start + t.size).map(b => b.type)).toEqual(['tkhd', 'edts', 'mdia'])
      // And what is left inside is EXACTLY the trim, verbatim, not the empty edit.
      expect(readElst(init, t)).toEqual([TRIM])
    }
    // The sizes have to genuinely add up: if the moov lied, a top-level
    // parseBoxes would not reach the end of the buffer.
    expect(parseBoxes(init).map(b => b.type)).toEqual(['ftyp', 'moov'])
    expect(moov.start + moov.size).toBe(init.length)
  })

  it('an elst holding only a trim (no empty edit) survives intact', () => {
    const trimOnly = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.concat([mvhd(1000, 4000),
        box('trak', Buffer.concat([tkhd(1, 4000), edts([TRIM]), box('mdia', mdhd(12800, 4000))]))])),
    ])
    const { init } = canonicalizeInit(trimOnly)
    const moov = parseBoxes(init).find(b => b.type === 'moov')!
    const [t] = parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    expect(parseBoxes(init, t.start + t.hdr, t.start + t.size).map(b => b.type)).toEqual(['tkhd', 'edts', 'mdia'])
    expect(readElst(init, t)).toEqual([TRIM])
    // The size cascade (elst→edts→trak→moov) has to genuinely add up.
    expect(moov.start + moov.size).toBe(init.length)
  })

  it('an elst holding only empty edits disappears entirely, along with its edts', () => {
    const emptyEditOnly = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.concat([mvhd(1000, 4000),
        box('trak', Buffer.concat([tkhd(1, 4000), edts([[20000, -1]]), box('mdia', mdhd(12800, 4000))]))])),
    ])
    const { init } = canonicalizeInit(emptyEditOnly)
    const moov = parseBoxes(init).find(b => b.type === 'moov')!
    const [t] = parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    expect(parseBoxes(init, t.start + t.hdr, t.start + t.size).map(b => b.type)).toEqual(['tkhd', 'mdia'])
    // Dropping the whole edts also has to keep the size cascade adding up.
    expect(moov.start + moov.size).toBe(init.length)
  })

  it('works the same on a version 1 (64-bit) elst, without promoting the version', () => {
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
    expect(init[elst.start + elst.hdr]).toBe(1) // still v1
    expect(readElst(init, t)).toEqual([TRIM])
    // This is the only coverage of the 20-byte entry arithmetic (v1): if it came
    // out short, parseBoxes would still find the trak just fine, so the size
    // cascade has to be checked explicitly.
    expect(moov.start + moov.size).toBe(init.length)
  })

  it('an elst with an inflated entry_count does not read past its own declared size', () => {
    // entry_count says 4, but the box is only sized for 2 real entries (24
    // bytes of payload after the 8-byte prologue, inside an elst of size 40 =
    // hdr 8 + 8 + 24). Unclamped, the loop would go on reading 2 more "entries"
    // out of the bytes right after the elst inside the trak: the following mdia.
    const lyingPrologue = Buffer.alloc(8)
    lyingPrologue.writeUInt32BE(4, 4) // entry_count LIES: says 4, only 2 fit
    const realEntries = Buffer.concat([[20000, -1], TRIM].map(([dur, mediaTime]) => {
      const e = Buffer.alloc(12)
      e.writeUInt32BE(dur, 0)
      e.writeInt32BE(mediaTime, 4)
      return e
    }))
    const lyingElst = box('elst', Buffer.concat([lyingPrologue, realEntries])) // real size = 40
    const trakBuf = Buffer.concat([
      tkhd(1, 4000), box('edts', lyingElst), box('mdia', mdhd(12800, 4000)),
    ])
    const withLie = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.concat([mvhd(1000, 4000), box('trak', trakBuf)])),
    ])
    const { init, timescales } = canonicalizeInit(withLie)
    const moov = parseBoxes(init).find(b => b.type === 'moov')!
    const [t] = parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    // The elst keeps only what genuinely fit in its declared size: the real
    // trim, not a phantom entry made of the following mdia's bytes.
    expect(readElst(init, t)).toEqual([TRIM])
    // And the mdia is untouched: had the elst swallowed its first bytes, this
    // timescale would come out corrupted or the trak would not be found at all.
    expect([...timescales]).toEqual([[1, 12800]])
    expect(moov.start + moov.size).toBe(init.length)
  })

  it('returns each track\'s timescale', () => {
    expect([...canonicalizeInit(fakeInit()).timescales]).toEqual([[1, 12800], [2, 44100]])
  })

  it('zeroes the durations, so two different runs produce the same init', () => {
    const from0 = canonicalizeInit(fakeInit()).init
    // A restarted run encodes less footage: different durations and a different
    // empty edit. The codec trim (TRIM) is the same in both runs, as in reality,
    // and has to survive identically on both sides.
    const other = Buffer.concat([
      box('ftyp', Buffer.alloc(8)),
      box('moov', Buffer.concat([
        mvhd(1000, 999), box('trak', Buffer.concat([tkhd(1, 111), edts([[77, -1], TRIM]), box('mdia', mdhd(12800, 111))])),
        box('trak', Buffer.concat([tkhd(2, 222), edts([[88, -1], TRIM]), box('mdia', mdhd(44100, 222))])),
      ])),
    ])
    expect(canonicalizeInit(other).init.equals(from0)).toBe(true)
  })

  it('does not touch the input buffer', () => {
    const raw = fakeInit()
    const copy = Buffer.from(raw)
    canonicalizeInit(raw)
    expect(raw.equals(copy)).toBe(true)
  })

  it('is idempotent: canonicalizing an already-canonical init changes nothing, and does not touch the trim again', () => {
    const once = canonicalizeInit(fakeInit()).init
    const twice = canonicalizeInit(once).init
    expect(twice.equals(once)).toBe(true)
    // Explicit on top of the byte-for-byte check: the trim is still the same
    // after two passes, not something a second pass could trim further.
    const moov = parseBoxes(twice).find(b => b.type === 'moov')!
    const [t] = parseBoxes(twice, moov.start + moov.hdr, moov.start + moov.size).filter(b => b.type === 'trak')
    expect(readElst(twice, t)).toEqual([TRIM])
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

// A header like the one ffmpeg writes: styp, one sidx per track, and a moof with
// one traf per track. A restarted run writes it with the tfdts at zero.
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
  it('moves each track\'s tfdt to start × its own timescale', () => {
    const out = retimeHeader(head(0, 0), SCALES, 20)
    expect(readTfdt(out, 0)).toBe(20 * 12800)
    expect(readTfdt(out, 1)).toBe(20 * 44100)
  })

  it('also moves the sidx\'s earliest_presentation_time', () => {
    const out = retimeHeader(head(0, 0), SCALES, 20)
    expect(readSidx(out, 0)).toBe(20 * 12800)
    expect(readSidx(out, 1)).toBe(20 * 44100)
  })

  it('shifts rather than sets: a second fragment keeps its spacing', () => {
    const two = Buffer.concat([
      head(0, 0),
      box('moof', Buffer.concat([
        box('mfhd', Buffer.alloc(8)),
        box('traf', Buffer.concat([tfhd(1), tfdt(2 * 12800)])),
        box('traf', Buffer.concat([tfhd(2), tfdt(2 * 44100)])),
      ])),
    ])
    const out = retimeHeader(two, SCALES, 20)
    expect(readTfdt(out, 2)).toBe(22 * 12800)
    expect(readTfdt(out, 3)).toBe(22 * 44100)
  })

  it('works the same on a run that already carried absolute times', () => {
    const out = retimeHeader(head(8 * 12800, 8 * 44100), SCALES, 20)
    expect(readTfdt(out, 0)).toBe(20 * 12800)
    expect(readTfdt(out, 1)).toBe(20 * 44100)
  })

  it('does not change the buffer size and does not touch the input', () => {
    const input = head(0, 0)
    const copy = Buffer.from(input)
    const out = retimeHeader(input, SCALES, 20)
    expect(out.length).toBe(input.length)
    expect(input.equals(copy)).toBe(true)
  })

  it('leaves a track whose timescale it does not know untouched', () => {
    const out = retimeHeader(head(0, 0), new Map([[1, 12800]]), 20)
    expect(readTfdt(out, 0)).toBe(20 * 12800)
    expect(readTfdt(out, 1)).toBe(0)
    expect(readSidx(out, 1)).toBe(0)
  })
})
