import { describe, it, expect } from 'vitest'
import { langFromAcceptLanguage, serverMessage } from '../src/i18n.js'

describe('langFromAcceptLanguage', () => {
  it('resolves the single tag the web client sends', () => {
    expect(langFromAcceptLanguage('es')).toBe('es')
    expect(langFromAcceptLanguage('en')).toBe('en')
  })

  it('follows the order of the header when it carries both', () => {
    expect(langFromAcceptLanguage('es-ES,es;q=0.9,en;q=0.8')).toBe('es')
    expect(langFromAcceptLanguage('en-US,en;q=0.9,es;q=0.8')).toBe('en')
  })

  it('falls back to English for foreign or missing headers', () => {
    expect(langFromAcceptLanguage('fr-FR,fr;q=0.9')).toBe('en')
    expect(langFromAcceptLanguage('')).toBe('en')
    expect(langFromAcceptLanguage(undefined)).toBe('en')
  })
})

describe('serverMessage', () => {
  it('translates API errors, interpolating values', () => {
    expect(serverMessage('en', 'error.pathNotFound', { path: '/x' })).toBe('path not found: /x')
    expect(serverMessage('es', 'error.pathNotFound', { path: '/x' })).toBe('la ruta no existe: /x')
    expect(serverMessage('es', 'error.roomBusy')).toBe('la sala está ocupada')
  })

  it('translates the native folder-picker prompt', () => {
    expect(serverMessage('en', 'prompt.pickFolder')).toBe('Pick your media folder')
    expect(serverMessage('es', 'prompt.pickFolder')).toBe('Elige tu carpeta de medios')
  })

  it('translates the placeholder title of an empty room', () => {
    expect(serverMessage('en', 'status.noMovie')).toBe('No movie')
    expect(serverMessage('es', 'status.noMovie')).toBe('Sin película')
  })
})
