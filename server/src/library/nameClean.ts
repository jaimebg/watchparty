const TAGS = /\b(2160p|1080p|720p|480p|4k|uhd|imax|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|hdtv|dvdrip|x264|x265|h264|h265|hevc|avc|aac\d?|ac3|eac3|dts|ddp?[57][\s.]?1|atmos|10bit|hdr10\+?|hdr|dv|remux|proper|repack|extended|unrated|multi|vose|castellano|latino|dual)\b/gi
// Tags "fuertes": a partir del primero, todo lo que sigue es release-junk
// (códec de audio, grupo, idiomas del rip...) y se trunca entero.
const STRONG = /\b(2160p|1080p|720p|480p|4k|uhd|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|hdtv|dvdrip|remux|x264|x265|h264|h265|hevc)\b/i

export function cleanName(filename: string): string {
  let s = filename.replace(/\.[^.]+$/, '')
  s = s.replace(/[._]/g, ' ')
  // Rescata el año de "(2026)"/"[2026]" antes de tirar los grupos entre
  // paréntesis/corchetes: es la señal más valiosa para los metadatos.
  s = s.replace(/[[(]\s*((?:19|20)\d{2})\s*[\])]/g, ' $1 ')
  s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
  const cut = s.match(STRONG)
  if (cut) s = s.slice(0, cut.index)
  const hadTags = TAGS.test(s)
  TAGS.lastIndex = 0 // regex global: resetear tras test()
  s = s.replace(TAGS, ' ')
  // El sufijo "-GRUPO" solo es grupo de release si el nombre llevaba tags de
  // calidad/códec; sin ellos, el guion es parte del título ("Spider-Man").
  if (cut || hadTags) s = s.replace(/-\s*[A-Za-z0-9]+\s*$/, ' ')
  return s.replace(/\s{2,}/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '')
}
