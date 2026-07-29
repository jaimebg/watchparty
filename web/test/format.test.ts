import { describe, it, expect } from 'vitest'
import { formatClock, spaceBelongsTo } from '../src/player/format'

describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [65, '1:05'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [4325.7, '1:12:05'],
    [-5, '0:00'],
  ])('%d -> %s', (sec, expected) => {
    expect(formatClock(sec as number)).toBe(expected)
  })
})

describe('spaceBelongsTo', () => {
  it.each([
    ['INPUT', 'text', false, true],
    ['INPUT', 'search', false, true],
    ['INPUT', 'range', false, false],
    ['TEXTAREA', undefined, false, true],
    ['SELECT', undefined, false, true],
    ['BUTTON', undefined, false, true],
    ['DIV', undefined, true, true],
    ['DIV', undefined, false, false],
    [undefined, undefined, undefined, false],
  ])('tag=%s type=%s editable=%s -> %s', (tag, type, editable, expected) => {
    expect(spaceBelongsTo(tag as string | undefined, type as string | undefined, editable as boolean | undefined)).toBe(expected)
  })
})
