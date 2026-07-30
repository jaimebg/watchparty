// El plano de datos (playlists, init, segmentos, VTT) puede vivir en un origen
// distinto al de la app: ver `streamBaseUrl` en server/src/config.ts para el por
// qué. Aquí solo se compone la URL.
//
// Basta con aplicarlo a master.m3u8 y a los VTT: HLS resuelve los nombres
// relativos de una playlist contra la URL de esa playlist, así que init_*.mp4 y
// seg_*.m4s siguen al host del master sin tocar planner.ts. Los <track>, en
// cambio, los construye la app y no la playlist, así que esos sí pasan por aquí.
export function streamUrl(base: string | null | undefined, token: string, file: string): string {
  // Se recorta la barra final para no emitir `https://host//stream/...`: un
  // doble slash sobrevive a la normalización de la URL y rompe el prefijo contra
  // el que se resuelven los nombres relativos de la playlist.
  const root = (base ?? '').replace(/\/+$/, '')
  return `${root}/stream/${token}/${file}`
}
