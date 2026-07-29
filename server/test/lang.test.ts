import { describe, it, expect } from 'vitest'
import { langLabel, guessLangFromName, detectLangFromText, enrichAudioLangs } from '../src/media/lang.js'

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

describe('enrichAudioLangs', () => {
  const und = { index: 0, codec: 'aac', lang: 'und', label: 'Pista 1', channels: 2 }
  it('una pista und + idioma original TMDB → etiquetada', () => {
    expect(enrichAudioLangs([und], 'Peli.2026.mp4', 'en')[0]).toMatchObject({ lang: 'en', label: 'English' })
  })
  it('la palabra del nombre del archivo gana al idioma original (doblaje)', () => {
    expect(enrichAudioLangs([und], 'Peli.2026.Castellano.mp4', 'en')[0]).toMatchObject({ lang: 'es', label: 'Español' })
  })
  it('pista ya etiquetada → intacta', () => {
    const spa = { ...und, lang: 'spa', label: 'Español' }
    expect(enrichAudioLangs([spa], 'x.mp4', 'en')[0]).toBe(spa)
  })
  it('varias pistas und → no se adivina', () => {
    const two = [und, { ...und, index: 1, label: 'Pista 2' }]
    expect(enrichAudioLangs(two, 'x.mp4', 'en')).toBe(two)
  })
  it('sin ninguna pista → intacto', () => {
    expect(enrichAudioLangs([und], 'x.mp4', null)[0]).toBe(und)
  })
})

describe('detectLangFromText', () => {
  const es = 'Pero qué está pasando aquí. Gracias señor, sí, cómo no. Porque los niños y las niñas cuando llegan más tarde. Está bien, gracias. Sí señor.'
  const en = 'What are you doing with the ship. You have this and that. The crew was here and you were there. What do you have. This is the end.'
  it('detecta español', () => expect(detectLangFromText(es)).toBe('es'))
  it('detecta inglés', () => expect(detectLangFromText(en)).toBe('en'))
  it('sin señal clara -> null', () => expect(detectLangFromText('12345 --> 000 abc xyz')).toBeNull())
})
