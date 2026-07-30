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
