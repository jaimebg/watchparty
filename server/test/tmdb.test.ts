import { describe, it, expect } from 'vitest'
import { parseTitleYear, mapTmdbResult, displayTitle, makeTmdbLookup } from '../src/media/tmdb.js'

describe('parseTitleYear', () => {
  it.each([
    ['La Peli 2023', { query: 'La Peli', year: 2023, episode: null }],
    ['Interstellar', { query: 'Interstellar', year: null, episode: null }],
    ['Serie S01E02', { query: 'Serie', year: null, episode: 'S01E02' }],
    ['Blade Runner 2049 2017', { query: 'Blade Runner 2049', year: 2017, episode: null }],
    ['1917 2019', { query: '1917', year: 2019, episode: null }],
  ])('%s', (input, expected) => {
    expect(parseTitleYear(input)).toEqual(expected)
  })
})

describe('mapTmdbResult', () => {
  it('maps a movie result', () => {
    const meta = mapTmdbResult({ results: [{ title: 'Interstellar', release_date: '2014-11-05', overview: 'Espacio.', poster_path: '/p.jpg', vote_average: 8.483, original_language: 'en' }] }, null)
    expect(meta).toEqual({
      title: 'Interstellar', year: 2014, overview: 'Espacio.',
      posterUrl: 'https://image.tmdb.org/t/p/w342/p.jpg', rating: 8.5, episodeTag: null, originalLang: 'en',
    })
  })
  it('maps a tv result with episode tag', () => {
    const meta = mapTmdbResult({ results: [{ name: 'La Serie', first_air_date: '2019-04-01', overview: '', vote_average: 0 }] }, 'S01E02')
    expect(meta).toMatchObject({ title: 'La Serie', year: 2019, posterUrl: null, rating: null, episodeTag: 'S01E02' })
  })
  it('tolerates garbage and empty results', () => {
    expect(mapTmdbResult(null, null)).toBeNull()
    expect(mapTmdbResult({ results: [] }, null)).toBeNull()
    expect(mapTmdbResult({ results: [{ overview: 'no title' }] }, null)).toBeNull()
  })
})

describe('displayTitle', () => {
  it('composes title, year and episode', () => {
    expect(displayTitle({ title: 'Interstellar', year: 2014, overview: '', posterUrl: null, rating: null, episodeTag: null, originalLang: 'en' }, 'x')).toBe('Interstellar (2014)')
    expect(displayTitle({ title: 'La Serie', year: 2019, overview: '', posterUrl: null, rating: null, episodeTag: 'S01E02', originalLang: 'en' }, 'x')).toBe('La Serie (2019) — S01E02')
    expect(displayTitle(null, 'bare file name')).toBe('bare file name')
  })
})

describe('makeTmdbLookup', () => {
  it('searches movie with year and maps the result', async () => {
    let calledUrl = ''
    const fetchStub = (async (url: string | URL | Request) => {
      calledUrl = String(url)
      return new Response(JSON.stringify({ results: [{ title: 'La Peli', release_date: '2023-01-01' }] }))
    }) as typeof fetch
    const meta = await makeTmdbLookup('KEY', fetchStub)('La Peli 2023')
    expect(calledUrl).toContain('/search/movie?')
    expect(calledUrl).toContain('query=La+Peli')
    expect(calledUrl).toContain('primary_release_year=2023')
    expect(meta?.title).toBe('La Peli')
  })
  it('searches tv for episodes and never throws on network errors', async () => {
    const boom = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    expect(await makeTmdbLookup('KEY', boom)('Serie S01E02')).toBeNull()
    let calledUrl = ''
    const fetchStub = (async (url: string | URL | Request) => {
      calledUrl = String(url)
      return new Response(JSON.stringify({ results: [] }))
    }) as typeof fetch
    expect(await makeTmdbLookup('KEY', fetchStub)('Serie S01E02')).toBeNull()
    expect(calledUrl).toContain('/search/tv?')
  })
})
