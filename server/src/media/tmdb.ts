// Metadatos de TMDB a partir del título limpio del archivo. La API key vive en
// la config del servidor y nunca llega al cliente. Cualquier fallo → null (los
// metadatos jamás bloquean la creación de una sala).

export interface RoomMeta {
  title: string
  year: number | null
  overview: string
  posterUrl: string | null
  rating: number | null
  episodeTag: string | null
  originalLang: string | null
}

// "La Peli 2023" → query "La Peli" + year 2023. "Serie S01E02" → query "Serie"
// + episode "S01E02" (se busca como serie de TV, no como película).
export function parseTitleYear(cleanTitle: string): { query: string; year: number | null; episode: string | null } {
  let query = cleanTitle
  const ep = query.match(/\bS(\d{1,2})E(\d{1,3})\b/i)
  const episode = ep ? ep[0].toUpperCase() : null
  if (ep) query = query.replace(ep[0], ' ')
  const years = query.match(/\b(19|20)\d{2}\b/g)
  const year = years ? Number(years[years.length - 1]) : null
  if (years) query = query.replace(new RegExp(`\\b${years[years.length - 1]}\\b`), ' ')
  query = query.replace(/\s{2,}/g, ' ').trim()
  return { query, year, episode }
}

export function mapTmdbResult(json: unknown, episodeTag: string | null): RoomMeta | null {
  const r = (json as { results?: unknown[] })?.results?.[0] as Record<string, unknown> | undefined
  if (!r) return null
  const title = r.title ?? r.name
  if (typeof title !== 'string' || !title) return null
  const date = r.release_date ?? r.first_air_date
  const year = typeof date === 'string' && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null
  return {
    title,
    year,
    overview: typeof r.overview === 'string' ? r.overview : '',
    posterUrl: typeof r.poster_path === 'string' ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : null,
    rating: typeof r.vote_average === 'number' && r.vote_average > 0 ? Math.round(r.vote_average * 10) / 10 : null,
    episodeTag,
    originalLang: typeof r.original_language === 'string' ? r.original_language : null,
  }
}

export function displayTitle(meta: RoomMeta | null, fallback: string): string {
  if (!meta) return fallback
  const year = meta.year ? ` (${meta.year})` : ''
  const ep = meta.episodeTag ? ` — ${meta.episodeTag}` : ''
  return `${meta.title}${year}${ep}`
}

export function makeTmdbLookup(apiKey: string, fetchImpl: typeof fetch = fetch) {
  return async (cleanTitle: string): Promise<RoomMeta | null> => {
    try {
      const { query, year, episode } = parseTitleYear(cleanTitle)
      if (!query) return null
      const kind = episode ? 'tv' : 'movie'
      const params = new URLSearchParams({ api_key: apiKey, query, language: 'es-ES' })
      if (year && !episode) params.set('primary_release_year', String(year))
      const res = await fetchImpl(`https://api.themoviedb.org/3/search/${kind}?${params}`, { signal: AbortSignal.timeout(6000) })
      if (!res.ok) return null
      return mapTmdbResult(await res.json(), episode)
    } catch {
      return null
    }
  }
}
