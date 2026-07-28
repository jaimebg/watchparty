const TAGS = /\b(2160p|1080p|720p|480p|4k|uhd|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|hdtv|dvdrip|x264|x265|h264|h265|hevc|avc|aac|ac3|eac3|dts|ddp?[57]\.1|atmos|10bit|hdr10\+?|hdr|dv|remux|proper|repack|extended|unrated|multi|vose|castellano|latino|dual)\b/gi

export function cleanName(filename: string): string {
  let s = filename.replace(/\.[^.]+$/, '')
  s = s.replace(/[._]/g, ' ')
  s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
  s = s.replace(TAGS, ' ')
  s = s.replace(/-\s*[A-Za-z0-9]+\s*$/, ' ')
  return s.replace(/\s{2,}/g, ' ').trim()
}
