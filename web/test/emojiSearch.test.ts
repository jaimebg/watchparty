import { describe, it, expect } from 'vitest'
import { EMOJI_GROUPS, normalize, searchEmojis, SEARCH_LIMIT, type EmojiRow } from '../src/chat/emojiSearch'

// Deliberately accented fixture data: normalize()'s whole job is making
// "corazon" find "corazón", so the test catalog has to carry the accents.
const CATALOG: EmojiRow[] = [
  ['🍿', 'palomitas', 'maíz cine', 4],
  ['❤️', 'corazón rojo', 'amor', 8],
  ['🔥', 'fuego', 'llama caliente', 5],
  ['😂', 'cara llorando de risa', 'risa lágrima', 0],
]

describe('normalize', () => {
  it('strips accents and lowercases', () => {
    expect(normalize('CoraZÓN')).toBe('corazon')
    expect(normalize('maíz')).toBe('maiz')
  })
})

describe('searchEmojis', () => {
  it('finds by label, ignoring accents', () => {
    expect(searchEmojis(CATALOG, 'corazon').map(r => r[0])).toEqual(['❤️'])
  })
  it('finds by keyword', () => {
    expect(searchEmojis(CATALOG, 'cine').map(r => r[0])).toEqual(['🍿'])
  })
  it('finds by a fragment of a word', () => {
    expect(searchEmojis(CATALOG, 'risa').map(r => r[0])).toEqual(['😂'])
  })
  it('an empty search returns nothing', () => {
    expect(searchEmojis(CATALOG, '   ')).toEqual([])
  })
  it('respects the result cap', () => {
    const many: EmojiRow[] = Array.from({ length: 500 }, (_, i) => [`e${i}`, 'thing', '', 0])
    expect(searchEmojis(many, 'thing')).toHaveLength(SEARCH_LIMIT)
    expect(searchEmojis(many, 'thing', 5)).toHaveLength(5)
  })
})

describe('EMOJI_GROUPS', () => {
  it('excludes group 2, which is modifiers rather than emotes', () => {
    expect(EMOJI_GROUPS.some(g => g.group === 2)).toBe(false)
  })
  it('covers the nine emote groups', () => {
    expect(EMOJI_GROUPS.map(g => g.group)).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('EMOJI_CATALOG', () => {
  it('carries the full catalog, well formed and free of modifiers', async () => {
    const { EMOJI_CATALOG } = await import('../src/chat/emojiCatalog')
    expect(EMOJI_CATALOG.length).toBeGreaterThan(1800)
    expect(EMOJI_CATALOG.every(r => r.length === 4)).toBe(true)
    expect(EMOJI_CATALOG.every(r => typeof r[0] === 'string' && r[0] !== '')).toBe(true)
    // Group 2 is skin tones and hair: none of it should have slipped in.
    expect(EMOJI_CATALOG.some(r => r[3] === 2)).toBe(false)
    // Labels come in English.
    expect(EMOJI_CATALOG.find(r => r[0] === '🍿')?.[1]).toBe('popcorn')
  })

  it('English search works against the real catalog', async () => {
    const { EMOJI_CATALOG } = await import('../src/chat/emojiCatalog')
    expect(searchEmojis(EMOJI_CATALOG, 'popcorn').map(r => r[0])).toContain('🍿')
    expect(searchEmojis(EMOJI_CATALOG, 'heart').length).toBeGreaterThan(0)
  })
})
