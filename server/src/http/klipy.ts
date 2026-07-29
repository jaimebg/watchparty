import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../app.js'

// Shape confirmado contra la API viva con una key de test el 2026-07-29:
//   GET https://api.klipy.com/api/v1/{KEY}/gifs/search?q=&page=1&per_page=24
//   -> { result, data: { data: [{ id, slug, title, file: { hd|md|sm|xs: { gif|webp|jpg|mp4|webm: { url, width, height, size } } }, tags, type, blur_preview }], current_page, per_page, has_next, meta } }
// El campo por item es `file` (singular); algunas docs muestran `files` (plural) — el mapper acepta ambos.
// This mapper therefore accepts both `file` and `files` defensively; unresolved beyond that
// without a live API key, so treat this as unconfirmed against the primary source.
export interface GifResult { id: string; title: string; previewUrl: string; url: string; width: number; height: number }

export function mapKlipyResponse(json: unknown): GifResult[] {
  const items = (json as any)?.data?.data
  if (!Array.isArray(items)) return []
  const out: GifResult[] = []
  for (const it of items) {
    const files = it?.file ?? it?.files ?? {}
    const pick = (...sizes: string[]) => { for (const s of sizes) { const f = files[s]?.gif; if (f?.url) return f } return null }
    const main = pick('md', 'hd', 'sm')
    const prev = pick('sm', 'md') ?? main
    if (!main) continue
    out.push({ id: String(it.id), title: String(it.title ?? ''), previewUrl: prev!.url, url: main.url, width: main.width ?? 0, height: main.height ?? 0 })
  }
  return out
}

export function registerKlipy(app: FastifyInstance, deps: AppDeps): void {
  const doFetch = deps.fetchImpl ?? fetch
  app.get('/api/gifs/search', async (req, reply) => {
    const { q, room } = req.query as { q?: string; room?: string }
    if (!deps.config.klipyApiKey) return reply.code(404).send({ gifsDisabled: true })
    if (!room || !deps.rooms.get(room)) return reply.code(401).send({ error: 'valid room required' })
    const url = `https://api.klipy.com/api/v1/${deps.config.klipyApiKey}/gifs/search?q=${encodeURIComponent(q ?? '')}&page=1&per_page=24`
    const res = await doFetch(url)
    if (!res.ok) return reply.code(502).send({ error: 'klipy error' })
    return { results: mapKlipyResponse(await res.json()) }
  })
}
