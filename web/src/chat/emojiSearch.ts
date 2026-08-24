// Each catalog row: [unicode, label, keywords, group].
// A tuple rather than an object because there are ~1,900 rows and the repeated
// field names would cost more than the data itself.
export type EmojiRow = [string, string, string, number]

// emojibase's group 2 is skin-tone and hair modifiers: they are not emotes and
// must not show up in the picker, so it gets no tab.
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

// Uncapped, searching for "a" would put over a thousand buttons in the DOM at once.
export const SEARCH_LIMIT = 120

export function normalize(s: string): string {
  // NFD separates the letter from its accent and the range deletes the
  // combining marks. Written with escapes on purpose: the literal characters are
  // invisible and do not survive copy-paste well.
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
