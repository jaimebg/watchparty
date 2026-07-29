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
