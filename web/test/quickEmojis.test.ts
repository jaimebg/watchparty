import { describe, it, expect } from 'vitest'
import { addQuick, DEFAULT_QUICK, MAX_QUICK, parseQuick, removeQuick } from '../src/chat/quickEmojis'

describe('parseQuick', () => {
  it('sin nada guardado devuelve los emojis por defecto', () => {
    expect(parseQuick(null)).toEqual(DEFAULT_QUICK)
  })
  it('JSON corrupto cae a los valores por defecto', () => {
    expect(parseQuick('{no es json')).toEqual(DEFAULT_QUICK)
  })
  it('un valor que no es array cae a los valores por defecto', () => {
    expect(parseQuick('{"a":1}')).toEqual(DEFAULT_QUICK)
    expect(parseQuick('"🔥"')).toEqual(DEFAULT_QUICK)
  })
  it('descarta entradas que no son string y cadenas vacías', () => {
    expect(parseQuick('["🔥", 3, null, "", "😂"]')).toEqual(['🔥', '😂'])
  })
  it('deduplica conservando el primer sitio', () => {
    expect(parseQuick('["🔥", "😂", "🔥"]')).toEqual(['🔥', '😂'])
  })
  it('recorta al tope', () => {
    const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => `e${i}`))
    expect(parseQuick(many)).toHaveLength(MAX_QUICK)
  })
  it('una lista vacía guardada se respeta, no se repuebla', () => {
    expect(parseQuick('[]')).toEqual([])
  })
})

describe('addQuick', () => {
  it('añade al final', () => {
    expect(addQuick(['🔥'], '😂')).toEqual(['🔥', '😂'])
  })
  it('no duplica', () => {
    const list = ['🔥', '😂']
    expect(addQuick(list, '🔥')).toBe(list)
  })
  it('no pasa del tope', () => {
    const full = Array.from({ length: MAX_QUICK }, (_, i) => `e${i}`)
    expect(addQuick(full, '🆕')).toBe(full)
  })
})

describe('removeQuick', () => {
  it('quita el emoji indicado y deja el resto en orden', () => {
    expect(removeQuick(['🔥', '😂', '💀'], '😂')).toEqual(['🔥', '💀'])
  })
  it('quitar algo que no está no cambia la lista', () => {
    expect(removeQuick(['🔥'], '😂')).toEqual(['🔥'])
  })
})
