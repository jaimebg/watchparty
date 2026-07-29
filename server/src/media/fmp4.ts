// Edición de cajas MP4 en memoria. Sin I/O y sin estado: es el único sitio del
// servidor que sabe de offsets dentro de un fMP4, para que transcoder.ts pueda
// hablar de «init canónico» y «tiempo absoluto» sin contar bytes.

export interface Box { type: string; start: number; hdr: number; size: number }

/**
 * Cajas de un rango del buffer, sin descender a los hijos. Ante una caja
 * incoherente (tamaño menor que su cabecera, o que se sale del rango) para en
 * seco: preferimos una lista corta a leer basura como si fuera estructura.
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
 * Offset donde empieza el `mdat` de un segmento, o -1 si no aparece.
 *
 * Pensado para un buffer PARCIAL: el `mdat` de un segmento de 4 s son megas, así
 * que su tamaño declarado casi nunca cabe en la cabecera que leemos. Por eso
 * comprueba el tipo ANTES de validar que la caja quepa entera, al revés que
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

// Contenedores que hay que reconstruir para poder editar el `elst` de dentro:
// quitar una entrada cambia el tamaño de su `elst` y, en cascada, el de su
// `edts`, su `trak` y su `moov`.
const REBUILD_PARENTS = new Set(['moov', 'trak', 'edts'])

// Tamaño de una entrada de elst: version(1)+flags(3) es el prólogo del elst,
// no de la entrada. v1 usa 64 bits para segment_duration y media_time; v0, 32.
function elstEntrySize(version: number): number {
  return version === 1 ? 20 : 12
}

// media_time de la entrada que empieza en `at`, sea v0 (32 bits) o v1 (64).
function elstMediaTime(buf: Buffer, at: number, version: number): number {
  return version === 1 ? Number(buf.readBigInt64BE(at + 8)) : buf.readInt32BE(at + 4)
}

/**
 * El `elst` sin sus «empty edits» (media_time == -1), o `null` si no queda
 * ninguna entrada.
 *
 * Un `elst` de ffmpeg trae normalmente DOS entradas y solo la primera depende
 * del run: el empty edit con `media_time = -1` guarda dónde arrancó ESE
 * proceso (medido: al reiniciar con `-ss 16`, esa entrada trae
 * `segment_duration = 16000` ms). La segunda entrada, con `media_time` >= 0,
 * es el trim del retardo propio del códec (medido con libx264: 1024 en el
 * timescale de la pista de vídeo, ~0,083 s; con audio o con
 * h264_videotoolbox, 0) — compensa que el primer sample del `trun` traiga un
 * `composition_time_offset` distinto de cero, y es IDÉNTICA en cualquier run
 * porque no depende de dónde arrancó ffmpeg. Tirar el `elst` entero (como
 * hacía la versión anterior) quitaba también esa compensación y dejaba el
 * vídeo reanclado con `retimeHeader` sistemáticamente tarde en esos mismos
 * ~0,083 s. Conservarla verbatim es lo que hace que la aritmética de
 * `retimeHeader` (tfdt = start × timescale) salga exacta.
 */
function rebuildElst(buf: Buffer, b: Box): Buffer | null {
  // Sin hueco ni para su propio prólogo (version+flags+entry_count) no hay
  // nada fiable que leer de esta caja: se trata como vacía en vez de
  // asomarse a bytes que, aunque estén dentro de `buf`, pertenecen a lo que
  // venga después (el `mdia` del mismo trak).
  if (b.size < b.hdr + 8) return null
  const version = buf[b.start + b.hdr]
  const entrySize = elstEntrySize(version)
  // Acotar entry_count a lo que de verdad cabe en el tamaño DECLARADO de la
  // caja: sin esto, un entry_count inflado (o una caja truncada) hace que el
  // bucle lea entradas fantasma de los bytes del `mdia` siguiente y las
  // conserve —su media_time no sería -1—, dejando un init corrompido en
  // silencio: los tamaños quedan igual de autoconsistentes, así que nada
  // lanza y ningún test de estructura falla. Mismo espíritu defensivo que
  // parseBoxes (para en seco) y headerLength (nunca se pasa del buffer).
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
    // Un `edts` cuyo `elst` se quedó sin entradas (solo tenía empty edits) no
    // aporta nada: se tira entero, igual que antes se tiraba siempre.
    if (b.type === 'edts' && kids.length === 0) continue
    const head = Buffer.from(buf.subarray(b.start, b.start + b.hdr))
    const total = b.hdr + kids.length
    if (b.hdr === 16) head.writeBigUInt64BE(BigInt(total), 8)
    else head.writeUInt32BE(total, 0)
    parts.push(head, kids)
  }
  return Buffer.concat(parts)
}

// mvhd/tkhd/mdhd comparten prólogo (creation, modification) pero tkhd mete
// track_id y un reservado antes de la duración; y la v1 usa 64 bits para las
// fechas y la duración. Offsets contados desde el final de version+flags.
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

// `track_id` en tkhd y `timescale` en mdhd caen en el mismo offset: tras el
// prólogo de fechas, que es lo único que cambia entre v0 y v1.
function readAfterDates(buf: Buffer, b: Box): number {
  const version = buf[b.start + b.hdr]
  return buf.readUInt32BE(b.start + b.hdr + (version === 1 ? 20 : 12))
}

/**
 * Init reproducible: sin las entradas del `elst` que dependen del run que lo
 * produjo, y con las duraciones a cero.
 *
 * ffmpeg guarda en el `edts` de cada pista la posición absoluta donde arrancó
 * ese proceso, como un «empty edit» (medido: `segment_duration = 16000` ms al
 * reiniciar con `-ss 16`). Como el servidor fija UN snapshot del init para
 * toda la sala, ese offset acabaría aplicándose a segmentos de cualquier otro
 * reinicio. Pero el `elst` no es solo eso: también trae, en una segunda
 * entrada, el trim del retardo propio del códec (compensa que el primer
 * sample del `trun` traiga un `composition_time_offset` != 0), que es igual
 * en todos los runs y que `retimeHeader` necesita para clavar el `tfdt` sin
 * dejar el vídeo sistemáticamente tarde. Por eso la cirugía es quirúrgica:
 * quitar solo las entradas con `media_time == -1` (rebuildElst), no el `edts`
 * entero. Las duraciones se ponen a cero por la misma razón que el empty
 * edit: un run reiniciado codifica menos metraje y las escribiría distintas.
 */
export function canonicalizeInit(raw: Buffer): CanonicalInit {
  // Buffer.concat copia, así que `init` es propio y se puede mutar sin tocar `raw`.
  const init = rebuildEdits(raw, 0, raw.length)
  const timescales = new Map<number, number>()
  const moov = parseBoxes(init).find(b => b.type === 'moov')
  if (!moov) throw new Error('init de fMP4 sin moov')
  for (const b of parseBoxes(init, moov.start + moov.hdr, moov.start + moov.size)) {
    if (b.type === 'mvhd') zeroDuration(init, b)
    if (b.type !== 'trak') continue
    let trackId = 0
    for (const t of parseBoxes(init, b.start + b.hdr, b.start + b.size)) {
      // tkhd va antes que mdia dentro de trak, así que para cuando se lee el
      // timescale el trackId ya está puesto.
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

// Se conserva la versión de la caja: promocionar una v0 a v1 cambiaría el
// tamaño, y con él el de todos sus padres. Desbordar los 32 bits de una v0
// exigiría ~13 h de película a timescale 90000, fuera del caso real.
function writeTime(buf: Buffer, at: number, version: number, value: number): void {
  const safe = Math.max(0, value)
  if (version === 1) buf.writeBigUInt64BE(BigInt(safe), at)
  else buf.writeUInt32BE(safe, at)
}

/**
 * Cabecera de segmento reanclada al instante absoluto que declara la playlist.
 *
 * ffmpeg numera cada reinicio desde su propio origen (medido: el `tfdt` del
 * segmento 5 vale 0 en un run que arrancó con `-ss 20`), así que el tiempo del
 * medio depende de qué proceso lo escribió. Aquí se fija por construcción.
 *
 * Desplaza en vez de fijar: el offset lo decide el PRIMER `moof` de cada pista y
 * los siguientes se mueven lo mismo, de modo que si algún día cae más de un
 * fragmento por segmento, su separación interna se conserva.
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
        // tfhd va antes que tfdt dentro de traf, así que el trackId ya está puesto.
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
  // Segunda pasada: el sidx va ANTES del moof en el archivo, pero su
  // desplazamiento sale del moof, así que no se puede resolver en la primera.
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
