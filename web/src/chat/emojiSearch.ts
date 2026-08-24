// Cada fila del catálogo: [unicode, etiqueta, palabras clave, grupo].
// Formato de tupla y no de objeto porque son ~1.900 filas y los nombres de
// campo repetidos costarían más que los propios datos.
export type EmojiRow = [string, string, string, number]

// El grupo 2 de emojibase son modificadores de tono de piel y de pelo: no son
// emotes y no deben aparecer en el selector, así que no tiene pestaña.
export const EMOJI_GROUPS: { group: number; label: string; icon: string }[] = [
  { group: 0, label: 'Smileys', icon: '😀' },
  { group: 1, label: 'People', icon: '👋' },
  { group: 3, label: 'Animals', icon: '🐱' },
  { group: 4, label: 'Food', icon: '🍕' },
  { group: 5, label: 'Travel', icon: '🚗' },
  { group: 6, label: 'Activities', icon: '🎉' },
  { group: 7, label: 'Objects', icon: '💡' },
  { group: 8, label: 'Symbols', icon: '❤️' },
  { group: 9, label: 'Flags', icon: '🏳️' },
]

// Sin tope, buscar «a» metería más de mil botones en el DOM de golpe.
export const SEARCH_LIMIT = 120

export function normalize(s: string): string {
  // NFD separa la letra de su tilde y el rango borra las marcas combinantes.
  // Escrito con escapes a propósito: los caracteres literales son invisibles y
  // no sobreviven bien a un copiar y pegar.
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export function searchEmojis(catalog: EmojiRow[], query: string, limit = SEARCH_LIMIT): EmojiRow[] {
  const q = normalize(query.trim())
  if (q === '') return []
  const out: EmojiRow[] = []
  for (const row of catalog) {
    if (normalize(row[1]).includes(q) || normalize(row[2]).includes(q)) {
      out.push(row)
      if (out.length === limit) break
    }
  }
  return out
}
