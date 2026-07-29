import { describe, it, expect } from 'vitest'
import { langLabel, guessLangFromName, detectLangFromText } from '../src/media/lang.js'

describe('langLabel', () => {
  it.each([
    ['es', 'Español'], ['spa', 'Español'], ['EN', 'English'], ['eng', 'English'],
    ['und', null], ['xx', null], [null, null],
  ])('%s -> %s', (code, expected) => {
    expect(langLabel(code as string | null)).toBe(expected)
  })
})

describe('guessLangFromName', () => {
  it.each([
    ['peli.es.srt', 'es'],
    ['peli.eng.srt', 'eng'],
    ['Peli.2020.Spanish.srt', 'es'],
    ['subs castellano.srt', 'es'],
    ['English subs.srt', 'en'],
    ['Project.Hail.Mary.2026-[YTS.BZ].srt', null],
  ])('%s -> %s', (name, expected) => {
    expect(guessLangFromName(name)).toBe(expected)
  })
})

describe('detectLangFromText', () => {
  const es = 'Pero qué está pasando aquí. Gracias señor, sí, cómo no. Porque los niños y las niñas cuando llegan más tarde. Está bien, gracias. Sí señor.'
  const en = 'What are you doing with the ship. You have this and that. The crew was here and you were there. What do you have. This is the end.'
  it('detecta español', () => expect(detectLangFromText(es)).toBe('es'))
  it('detecta inglés', () => expect(detectLangFromText(en)).toBe('en'))
  it('sin señal clara -> null', () => expect(detectLangFromText('12345 --> 000 abc xyz')).toBeNull())
})
