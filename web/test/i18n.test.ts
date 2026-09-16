import { describe, it, expect } from 'vitest'
import { detectLang, langFromSearch, messages, translate, type MsgKey } from '../src/i18n'

describe('detectLang', () => {
  it('picks Spanish when it is the first supported preference', () => {
    expect(detectLang(['es-ES', 'en-US'])).toBe('es')
  })

  it('resolves regional variants by their base language', () => {
    expect(detectLang(['es-419'])).toBe('es')
    expect(detectLang(['en-GB'])).toBe('en')
  })

  it('respects the order between the two supported languages', () => {
    expect(detectLang(['en-US', 'es-ES'])).toBe('en')
  })

  it('falls back to Spanish with unsupported languages ahead of it', () => {
    expect(detectLang(['fr-FR', 'de', 'es'])).toBe('es')
  })

  it('falls back to English when no preference is Spanish', () => {
    expect(detectLang(['fr-FR', 'de-DE'])).toBe('en')
  })

  it('handles a bare string, an empty list and undefined', () => {
    expect(detectLang('es-MX')).toBe('es')
    expect(detectLang([])).toBe('en')
    expect(detectLang(undefined)).toBe('en')
  })
})

describe('langFromSearch', () => {
  it('accepts the supported overrides', () => {
    expect(langFromSearch('?key=abc&lang=es')).toBe('es')
    expect(langFromSearch('?lang=en')).toBe('en')
  })

  it('ignores missing or unsupported values', () => {
    expect(langFromSearch('')).toBeNull()
    expect(langFromSearch('?lang=fr')).toBeNull()
  })
})

describe('messages', () => {
  it('has the same keys in both catalogs', () => {
    expect(Object.keys(messages.es).sort()).toEqual(Object.keys(messages.en).sort())
  })

  it('has no empty string in either catalog', () => {
    for (const [lang, catalog] of Object.entries(messages)) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `${lang}:${key}`).not.toBe('')
      }
    }
  })

  it('translates every phrase, leaving no English copy behind', () => {
    const untranslated = (Object.keys(messages.en) as MsgKey[]).filter(k => messages.en[k] === messages.es[k])
    expect(untranslated).toEqual([])
  })
})

describe('translate', () => {
  it('returns the message in the requested language', () => {
    expect(translate('en', 'chat.send')).toBe('Send')
    expect(translate('es', 'chat.send')).toBe('Enviar')
  })

  it('interpolates variables into the message', () => {
    expect(translate('es', 'chat.seek', { name: 'Ana', time: '01:20' })).toBe('Ana saltó a 01:20')
    expect(translate('en', 'chat.seek', { name: 'Ana', time: '01:20' })).toBe('Ana jumped to 01:20')
  })

  it('repeats a variable used twice', () => {
    expect(translate('en', 'emoji.remove', { emoji: '🔥' })).toContain('🔥')
  })
})
