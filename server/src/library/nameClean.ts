const TAGS = /\b(2160p|1080p|720p|480p|4k|uhd|imax|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|hdtv|dvdrip|x264|x265|h264|h265|hevc|avc|aac\d?|ac3|eac3|dts|ddp?[57][\s.]?1|atmos|10bit|hdr10\+?|hdr|dv|remux|proper|repack|extended|unrated|multi|vose|castellano|latino|dual)\b/gi
// "Strong" tags: from the first one onward, everything that follows is release
// junk (audio codec, group, rip languages, …) and gets truncated wholesale.
const STRONG = /\b(2160p|1080p|720p|480p|4k|uhd|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|hdtv|dvdrip|remux|x264|x265|h264|h265|hevc)\b/i

export function cleanName(filename: string): string {
  let s = filename.replace(/\.[^.]+$/, '')
  s = s.replace(/[._]/g, ' ')
  // Rescue the year from "(2026)"/"[2026]" before dropping bracketed and
  // parenthesised groups: it is the most valuable signal for the metadata.
  s = s.replace(/[[(]\s*((?:19|20)\d{2})\s*[\])]/g, ' $1 ')
  s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
  const cut = s.match(STRONG)
  if (cut) s = s.slice(0, cut.index)
  const hadTags = TAGS.test(s)
  TAGS.lastIndex = 0 // global regex: reset after test()
  s = s.replace(TAGS, ' ')
  // A "-GROUP" suffix is only a release group when the name carried
  // quality/codec tags; without them, the hyphen is part of the title
  // ("Spider-Man").
  if (cut || hadTags) s = s.replace(/-\s*[A-Za-z0-9]+\s*$/, ' ')
  return s.replace(/\s{2,}/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '')
}
