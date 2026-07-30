// El plano de datos (playlists, init, segmentos, VTT) puede vivir en un origen
// distinto al de la app: ver `streamBaseUrl` en server/src/config.ts para el por
// qué. Aquí solo se compone la URL.
//
// El `epoch` versiona la generación de película de la sala. Va en el PATH y no
// en una query por dos razones: los nombres relativos de una playlist se
// resuelven contra la URL de esa playlist, así que init_*.mp4 y seg_*.m4s caen
// dentro de e<n>/ solos y planner.ts no necesita saber que el epoch existe; y
// así el versionado no depende de que el proxy del relevo reenvíe la query ni
// de cómo calcule su clave de caché.
//
// Basta con aplicarlo a master.m3u8 y a los VTT: el resto de la playlist sigue
// al host y al epoch del master. Los <track>, en cambio, los construye la app y
// no la playlist, así que esos sí pasan por aquí.
export function streamUrl(base: string | null | undefined, token: string, epoch: number, file: string): string {
  // Se recorta la barra final para no emitir `https://host//stream/...`: un
  // doble slash sobrevive a la normalización de la URL y rompe el prefijo contra
  // el que se resuelven los nombres relativos de la playlist.
  const root = (base ?? '').replace(/\/+$/, '')
  return `${root}/stream/${token}/e${epoch}/${file}`
}
