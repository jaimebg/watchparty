// In-memory MP4 box editing. No I/O and no state: the one place in the server
// that knows about offsets inside an fMP4, so transcoder.ts can talk about a
// "canonical init" and "absolute time" without counting bytes.

export interface Box { type: string; start: number; hdr: number; size: number }

/**
 * The boxes in a range of the buffer, without descending into children. On an
 * incoherent box (size smaller than its header, or running past the range) it
 * stops dead: a short list beats reading garbage as if it were structure.
 */
export function parseBoxes(buf: Buffer, start = 0, end = buf.length): Box[] {
  const out: Box[] = []
  let p = start
  while (p + 8 <= end) {
    const declared = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    let hdr = 8
    let size = declared
    if (declared === 1) {
      if (p + 16 > end) break
      size = Number(buf.readBigUInt64BE(p + 8))
      hdr = 16
    } else if (declared === 0) {
      size = end - p
    }
    if (size < hdr || p + size > end) break
    out.push({ type, start: p, hdr, size })
    p += size
  }
  return out
}

/**
 * Offset where a segment's `mdat` starts, or -1 if it does not show up.
 *
 * Built for a PARTIAL buffer: the `mdat` of a 4 s segment is megabytes, so its
 * declared size almost never fits in the header we read. That is why it checks
 * the type BEFORE validating that the whole box fits, the opposite of
 * parseBoxes.
 */
export function headerLength(buf: Buffer): number {
  let p = 0
  while (p + 8 <= buf.length) {
    const declared = buf.readUInt32BE(p)
    if (buf.toString('latin1', p + 4, p + 8) === 'mdat') return p
    let hdr = 8
    let size = declared
    if (declared === 1) {
      if (p + 16 > buf.length) return -1
      size = Number(buf.readBigUInt64BE(p + 8))
      hdr = 16
    } else if (declared === 0) {
      return -1
    }
    if (size < hdr || p + size > buf.length) return -1
    p += size
  }
  return -1
}

export interface CanonicalInit { init: Buffer; timescales: Map<number, number> }

// Containers that must be rebuilt in order to edit the `elst` inside them:
// removing an entry changes the size of its `elst` and, in cascade, of its
// `edts`, its `trak` and its `moov`.
const REBUILD_PARENTS = new Set(['moov', 'trak', 'edts'])

// Size of one elst entry: version(1)+flags(3) is the elst's prologue, not the
// entry's. v1 uses 64 bits for segment_duration and media_time; v0 uses 32.
function elstEntrySize(version: number): number {
  return version === 1 ? 20 : 12
}

// media_time of the entry starting at `at`, whether v0 (32 bits) or v1 (64).
function elstMediaTime(buf: Buffer, at: number, version: number): number {
  return version === 1 ? Number(buf.readBigInt64BE(at + 8)) : buf.readInt32BE(at + 4)
}

/**
 * The `elst` with its "empty edits" (media_time == -1) removed, or `null` if no
 * entry survives.
 *
 * An ffmpeg `elst` normally carries TWO entries and only the first depends on
 * the run: the empty edit with `media_time = -1` records where THAT process
 * started (measured: restarting with `-ss 16` gives that entry a
 * `segment_duration = 16000` ms). The second entry, with `media_time` >= 0, is
 * the codec's own delay trim (measured with libx264: 1024 in the video track's
 * timescale, ~0.083 s; with audio or with h264_videotoolbox, 0). It compensates
 * for the first `trun` sample carrying a non-zero `composition_time_offset`, and
 * it is IDENTICAL across runs because it does not depend on where ffmpeg
 * started. Dropping the whole `elst` (as the previous version did) also dropped
 * that compensation and left video re-anchored by `retimeHeader` systematically
 * late by exactly those ~0.083 s. Keeping it verbatim is what makes
 * `retimeHeader`'s arithmetic (tfdt = start × timescale) come out exact.
 */
function rebuildElst(buf: Buffer, b: Box): Buffer | null {
  // Without room for even its own prologue (version+flags+entry_count) there is
  // nothing trustworthy to read out of this box: treat it as empty rather than
  // peek at bytes that, while inside `buf`, belong to whatever comes next (the
  // same trak's `mdia`).
  if (b.size < b.hdr + 8) return null
  const version = buf[b.start + b.hdr]
  const entrySize = elstEntrySize(version)
  // Clamp entry_count to what actually fits in the box's DECLARED size: without
  // this, an inflated entry_count (or a truncated box) makes the loop read
  // phantom entries out of the following `mdia`'s bytes and keep them — their
  // media_time would not be -1 — leaving a corrupted init behind in silence: the
  // sizes stay just as self-consistent, so nothing throws and no structural test
  // fails. Same defensive spirit as parseBoxes (stops dead) and headerLength
  // (never runs past the buffer).
  const maxEntries = Math.floor((b.size - b.hdr - 8) / entrySize)
  const count = Math.min(buf.readUInt32BE(b.start + b.hdr + 4), maxEntries)
  const kept: Buffer[] = []
  let p = b.start + b.hdr + 8
  for (let i = 0; i < count; i++) {
    if (elstMediaTime(buf, p, version) !== -1) kept.push(buf.subarray(p, p + entrySize))
    p += entrySize
  }
  if (kept.length === 0) return null
  const prologue = Buffer.from(buf.subarray(b.start + b.hdr, b.start + b.hdr + 8))
  prologue.writeUInt32BE(kept.length, 4)
  const payload = Buffer.concat([prologue, ...kept])
  const head = Buffer.from(buf.subarray(b.start, b.start + b.hdr))
  const total = b.hdr + payload.length
  if (b.hdr === 16) head.writeBigUInt64BE(BigInt(total), 8)
  else head.writeUInt32BE(total, 0)
  return Buffer.concat([head, payload])
}

function rebuildEdits(buf: Buffer, start: number, end: number): Buffer {
  const parts: Buffer[] = []
  for (const b of parseBoxes(buf, start, end)) {
    if (b.type === 'elst') {
      const edited = rebuildElst(buf, b)
      if (edited) parts.push(edited)
      continue
    }
    if (!REBUILD_PARENTS.has(b.type)) {
      parts.push(buf.subarray(b.start, b.start + b.size))
      continue
    }
    const kids = rebuildEdits(buf, b.start + b.hdr, b.start + b.size)
    // An `edts` whose `elst` ran out of entries (it held only empty edits) adds
    // nothing: drop it whole, the way it used to be dropped unconditionally.
    if (b.type === 'edts' && kids.length === 0) continue
    const head = Buffer.from(buf.subarray(b.start, b.start + b.hdr))
    const total = b.hdr + kids.length
    if (b.hdr === 16) head.writeBigUInt64BE(BigInt(total), 8)
    else head.writeUInt32BE(total, 0)
    parts.push(head, kids)
  }
  return Buffer.concat(parts)
}

// mvhd/tkhd/mdhd share a prologue (creation, modification) but tkhd slips
// track_id and a reserved field in before the duration; and v1 uses 64 bits for
// the dates and the duration. Offsets are counted from the START of the payload
// (version+flags included: mvhd v0 → 16 = 4+4+4+4), not from its end.
function durationOffset(type: string, version: number): number {
  if (type === 'tkhd') return version === 1 ? 28 : 20
  return version === 1 ? 24 : 16
}

function zeroDuration(buf: Buffer, b: Box): void {
  const version = buf[b.start + b.hdr]
  const at = b.start + b.hdr + durationOffset(b.type, version)
  if (version === 1) buf.writeBigUInt64BE(0n, at)
  else buf.writeUInt32BE(0, at)
}

// `track_id` in tkhd and `timescale` in mdhd land at the same offset: right
// after the date prologue, which is the only thing that differs between v0 and v1.
function readAfterDates(buf: Buffer, b: Box): number {
  const version = buf[b.start + b.hdr]
  return buf.readUInt32BE(b.start + b.hdr + (version === 1 ? 20 : 12))
}

/**
 * A reproducible init: without the `elst` entries that depend on the run that
 * produced it, and with the durations zeroed.
 *
 * ffmpeg records in each track's `edts` the absolute position where that process
 * started, as an "empty edit" (measured: `segment_duration = 16000` ms when
 * restarting with `-ss 16`). Since the server pins ONE init snapshot for the
 * whole room, that offset would end up applied to segments from any other
 * restart. But the `elst` is not only that: it also carries, in a second entry,
 * the codec's own delay trim (compensating for a first `trun` sample with a
 * `composition_time_offset` != 0), which is the same across runs and which
 * `retimeHeader` needs in order to nail the `tfdt` without leaving video
 * systematically late. Hence the surgery is surgical: remove only the entries
 * with `media_time == -1` (rebuildElst), not the whole `edts`. The durations are
 * zeroed for the same reason as the empty edit: a restarted run encodes less
 * footage and would write them differently.
 */
export function canonicalizeInit(raw: Buffer): CanonicalInit {
  // Buffer.concat copies, so `init` is ours and can be mutated without touching `raw`.
  const init = rebuildEdits(raw, 0, raw.length)
  const timescales = new Map<number, number>()
  const moov = parseBoxes(init).find(b => b.type === 'moov')
  if (!moov) throw new Error('fMP4 init without a moov')
  for (const b of parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size)) {
    if (b.type === 'mvhd') zeroDuration(init, b)
    if (b.type !== 'trak') continue
    let trackId = 0
    for (const t of parseBoxes(init, b.start + b.hdr, b.start + b.size)) {
      // tkhd comes before mdia inside trak, so by the time the timescale is
      // read the trackId is already set.
      if (t.type === 'tkhd') { trackId = readAfterDates(init, t); zeroDuration(init, t) }
      if (t.type !== 'mdia') continue
      for (const m of parseBoxes(init, t.start + t.hdr, t.start + t.size)) {
        if (m.type !== 'mdhd') continue
        timescales.set(trackId, readAfterDates(init, m))
        zeroDuration(init, m)
      }
    }
  }
  return { init, timescales }
}

function readTime(buf: Buffer, at: number, version: number): number {
  return version === 1 ? Number(buf.readBigUInt64BE(at)) : buf.readUInt32BE(at)
}

// The box's version is preserved: promoting a v0 to v1 would change its size,
// and with it every parent's. Overflowing a v0's 32 bits would take a ~13 h
// movie at timescale 90000, outside the real case.
function writeTime(buf: Buffer, at: number, version: number, value: number): void {
  const safe = Math.max(0, value)
  if (version === 1) buf.writeBigUInt64BE(BigInt(safe), at)
  else buf.writeUInt32BE(safe, at)
}

/**
 * A segment header re-anchored to the absolute instant the playlist declares.
 *
 * ffmpeg numbers every restart from its own origin (measured: segment 5's `tfdt`
 * is 0 in a run that started with `-ss 20`), so media time depends on which
 * process wrote it. Here it is pinned by construction.
 *
 * It shifts rather than sets: the offset is decided by each track's FIRST `moof`
 * and the rest move by the same amount, so if more than one fragment per segment
 * ever shows up, their internal spacing is preserved.
 */
export function retimeHeader(head: Buffer, timescales: Map<number, number>, startSec: number): Buffer {
  const out = Buffer.from(head)
  const deltas = new Map<number, number>()
  for (const moof of parseBoxes(out)) {
    if (moof.type !== 'moof') continue
    for (const traf of parseBoxes(out, moof.start + moof.hdr, moof.start + moof.size)) {
      if (traf.type !== 'traf') continue
      let trackId = 0
      for (const b of parseBoxes(out, traf.start + traf.hdr, traf.start + traf.size)) {
        // tfhd comes before tfdt inside traf, so the trackId is already set.
        if (b.type === 'tfhd') { trackId = out.readUInt32BE(b.start + b.hdr + 4); continue }
        if (b.type !== 'tfdt') continue
        const timescale = timescales.get(trackId)
        if (timescale === undefined) continue
        const version = out[b.start + b.hdr]
        const at = b.start + b.hdr + 4
        const current = readTime(out, at, version)
        if (!deltas.has(trackId)) deltas.set(trackId, Math.round(startSec * timescale) - current)
        writeTime(out, at, version, current + deltas.get(trackId)!)
      }
    }
  }
  // Second pass: the sidx comes BEFORE the moof in the file, but its shift is
  // derived from the moof, so it cannot be resolved in the first pass.
  for (const b of parseBoxes(out)) {
    if (b.type !== 'sidx') continue
    const delta = deltas.get(out.readUInt32BE(b.start + b.hdr + 4))
    if (delta === undefined) continue
    const version = out[b.start + b.hdr]
    const at = b.start + b.hdr + 12
    writeTime(out, at, version, readTime(out, at, version) + delta)
  }
  return out
}
