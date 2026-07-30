import { describe, it, expect } from 'vitest'
import { EMOJI_GROUPS, normalize, searchEmojis, SEARCH_LIMIT, type EmojiRow } from '../src/chat/emojiSearch'

const CATALOG: EmojiRow[] = [
  ['🍿', 'palomitas', 'maíz cine', 4],
  ['❤️', 'corazón rojo', 'amor', 8],
  ['🔥', 'fuego', 'llama caliente', 5],
  ['😂', 'cara llorando de risa', 'risa lágrima', 0],
]

describe('normalize', () => {
  it('quita acentos y pasa a minúsculas', () => {
    expect(normalize('CoraZÓN')).toBe('corazon')
    expect(normalize('maíz')).toBe('maiz')
  })
})

describe('searchEmojis', () => {
  it('encuentra por etiqueta ignorando acentos', () => {
    expect(searchEmojis(CATALOG, 'corazon').map(r => r[0])).toEqual(['❤️'])
  })
  it('encuentra por palabra clave', () => {
    expect(searchEmojis(CATALOG, 'cine').map(r => r[0])).toEqual(['🍿'])
  })
  it('encuentra por trozo de palabra', () => {
    expect(searchEmojis(CATALOG, 'risa').map(r => r[0])).toEqual(['😂'])
  })
  it('una búsqueda vacía no devuelve nada', () => {
    expect(searchEmojis(CATALOG, '   ')).toEqual([])
  })
  it('respeta el tope de resultados', () => {
    const many: EmojiRow[] = Array.from({ length: 500 }, (_, i) => [`e${i}`, 'cosa', '', 0])
    expect(searchEmojis(many, 'cosa')).toHaveLength(SEARCH_LIMIT)
    expect(searchEmojis(many, 'cosa', 5)).toHaveLength(5)
  })
})

describe('EMOJI_GROUPS', () => {
  it('no incluye el grupo 2, que son modificadores y no emotes', () => {
    expect(EMOJI_GROUPS.some(g => g.group === 2)).toBe(false)
  })
  it('cubre los nueve grupos de emotes', () => {
    expect(EMOJI_GROUPS.map(g => g.group)).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('EMOJI_CATALOG', () => {
  it('trae el catálogo completo, bien formado y sin modificadores', async () => {
    const { EMOJI_CATALOG } = await import('../src/chat/emojiCatalog')
    expect(EMOJI_CATALOG.length).toBeGreaterThan(1800)
    expect(EMOJI_CATALOG.every(r => r.length === 4)).toBe(true)
    expect(EMOJI_CATALOG.every(r => typeof r[0] === 'string' && r[0] !== '')).toBe(true)
    // El grupo 2 son tonos de piel y pelo: no deben haberse colado.
    expect(EMOJI_CATALOG.some(r => r[3] === 2)).toBe(false)
    // Las etiquetas vienen en castellano.
    expect(EMOJI_CATALOG.find(r => r[0] === '🍿')?.[1]).toBe('palomitas')
  })

  it('la búsqueda en castellano funciona sobre el catálogo real', async () => {
    const { EMOJI_CATALOG } = await import('../src/chat/emojiCatalog')
    expect(searchEmojis(EMOJI_CATALOG, 'palomitas').map(r => r[0])).toContain('🍿')
    expect(searchEmojis(EMOJI_CATALOG, 'corazon').length).toBeGreaterThan(0)
  })
})
