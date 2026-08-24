import { describe, it, expect } from 'vitest'
import { addQuick, DEFAULT_QUICK, MAX_QUICK, parseQuick, removeQuick } from '../src/chat/quickEmojis'

describe('parseQuick', () => {
  it('returns the default emojis when nothing is stored', () => {
    expect(parseQuick(null)).toEqual(DEFAULT_QUICK)
  })
  it('corrupt JSON falls back to the defaults', () => {
    expect(parseQuick('{not json')).toEqual(DEFAULT_QUICK)
  })
  it('a non-array value falls back to the defaults', () => {
    expect(parseQuick('{"a":1}')).toEqual(DEFAULT_QUICK)
    expect(parseQuick('"🔥"')).toEqual(DEFAULT_QUICK)
  })
  it('discards non-string entries and empty strings', () => {
    expect(parseQuick('["🔥", 3, null, "", "😂"]')).toEqual(['🔥', '😂'])
  })
  it('deduplicates, keeping the first position', () => {
    expect(parseQuick('["🔥", "😂", "🔥"]')).toEqual(['🔥', '😂'])
  })
  it('trims to the cap', () => {
    const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => `e${i}`))
    expect(parseQuick(many)).toHaveLength(MAX_QUICK)
  })
  it('a stored empty list is respected, not repopulated', () => {
    expect(parseQuick('[]')).toEqual([])
  })
})

describe('addQuick', () => {
  it('appends at the end', () => {
    expect(addQuick(['🔥'], '😂')).toEqual(['🔥', '😂'])
  })
  it('does not duplicate', () => {
    const list = ['🔥', '😂']
    expect(addQuick(list, '🔥')).toBe(list)
  })
  it('does not exceed the cap', () => {
    const full = Array.from({ length: MAX_QUICK }, (_, i) => `e${i}`)
    expect(addQuick(full, '🆕')).toBe(full)
  })
})

describe('removeQuick', () => {
  it('removes the named emoji and leaves the rest in order', () => {
    expect(removeQuick(['🔥', '😂', '💀'], '😂')).toEqual(['🔥', '💀'])
  })
  it('removing something absent does not change the list', () => {
    expect(removeQuick(['🔥'], '😂')).toEqual(['🔥'])
  })
})
