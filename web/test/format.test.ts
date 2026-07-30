import { describe, it, expect } from 'vitest'
import { clampPosition, formatClock, isTypingTarget, parseClock, parseStoredVolume, positionGradient, spaceBelongsTo, volumeGradient } from '../src/player/format'

describe('parseClock', () => {
  it.each([
    ['1:27:00', 5220],
    ['0:87:00', 5220],
    ['87:00', 5220],
    ['5220', 5220],
    ['  1:27:00  ', 5220],
    ['1:27:5', 5225],
    ['0', 0],
    ['2:03:04', 7384],
  ])('%s -> %d s', (raw, expected) => {
    expect(parseClock(raw)).toBe(expected)
  })

  it.each(['', '   ', 'basura', '1:2:3:4', '1:ab', '-30', '1:-2'])('rejects %s', raw => {
    expect(parseClock(raw)).toBeNull()
  })
})

describe('parseStoredVolume', () => {
  it.each([
    [null, 1],
    ['', 1],
    ['basura', 1],
    ['0.5', 0.5],
    ['0', 0],
    ['1', 1],
    ['1.7', 1.7],
    ['2', 2],
    ['3', 2],
    ['-3', 0],
  ])('%s -> %d', (raw, expected) => {
    expect(parseStoredVolume(raw as string | null)).toBe(expected)
  })
})

describe('volumeGradient', () => {
  it('below unity paints only the normal fill', () => {
    expect(volumeGradient(0.5)).toBe('linear-gradient(90deg, var(--seek-fill) 25%, var(--seek-track) 25%)')
  })

  it('at unity stops exactly at the halfway mark, still without boost colour', () => {
    expect(volumeGradient(1)).toBe('linear-gradient(90deg, var(--seek-fill) 50%, var(--seek-track) 50%)')
  })

  it('above unity paints the amplified stretch in the boost colour', () => {
    expect(volumeGradient(1.5)).toBe(
      'linear-gradient(90deg, var(--seek-fill) 50%, var(--boost-fill) 50%, var(--boost-fill) 75%, var(--seek-track) 75%)',
    )
  })

  it('clamps out-of-range values instead of overflowing the track', () => {
    expect(volumeGradient(9)).toContain('var(--seek-track) 100%')
    expect(volumeGradient(-1)).toBe('linear-gradient(90deg, var(--seek-fill) 0%, var(--seek-track) 0%)')
  })
})

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

describe('clampPosition', () => {
  it('recorta al metraje real por los dos lados', () => {
    expect(clampPosition(-5, 100)).toBe(0)
    expect(clampPosition(500, 100)).toBe(100)
    expect(clampPosition(42, 100)).toBe(42)
  })

  it('un valor no finito vale 0, no un NaN que viaje por el socket', () => {
    expect(clampPosition(NaN, 100)).toBe(0)
    expect(clampPosition(Infinity, 100)).toBe(100)
  })

  it('con duración desconocida (0) no deja pasar posiciones inventadas', () => {
    expect(clampPosition(42, 0)).toBe(0)
  })
})

describe('positionGradient', () => {
  it('pinta el relleno hasta el porcentaje visto', () => {
    expect(positionGradient(25, 100)).toBe(
      'linear-gradient(90deg, var(--seek-fill) 25%, var(--seek-track) 25%)',
    )
  })

  it('sin duración conocida no rellena nada', () => {
    expect(positionGradient(10, 0)).toBe(
      'linear-gradient(90deg, var(--seek-fill) 0%, var(--seek-track) 0%)',
    )
  })
})

describe('isTypingTarget', () => {
  it.each([
    ['INPUT', 'text', true],
    ['INPUT', undefined, true],
    ['TEXTAREA', undefined, true],
    ['SELECT', undefined, true],
  ])('%s/%s se está escribiendo', (tag, type, expected) => {
    expect(isTypingTarget(tag, type)).toBe(expected)
  })

  it('un range no recibe texto', () => {
    expect(isTypingTarget('INPUT', 'range')).toBe(false)
  })

  it('contenteditable cuenta como escritura', () => {
    expect(isTypingTarget('DIV', undefined, true)).toBe(true)
  })

  it('un botón NO cuenta: la F debe funcionar con un botón enfocado', () => {
    expect(isTypingTarget('BUTTON')).toBe(false)
    // …a diferencia del espacio, que sí pertenece al botón.
    expect(spaceBelongsTo('BUTTON')).toBe(true)
  })

  it('sin foco en nada, no se está escribiendo', () => {
    expect(isTypingTarget(undefined, undefined, undefined)).toBe(false)
  })
})
