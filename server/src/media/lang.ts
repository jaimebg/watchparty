// Human-readable language names for track labels (ISO 639-1/639-2 codes).
const LANG_NAMES: Record<string, string> = {
  es: 'Español', spa: 'Español',
  en: 'English', eng: 'English',
  fr: 'Français', fre: 'Français', fra: 'Français',
  de: 'Deutsch', ger: 'Deutsch', deu: 'Deutsch',
  it: 'Italiano', ita: 'Italiano',
  pt: 'Português', por: 'Português',
  ca: 'Català', cat: 'Català',
  eu: 'Euskera', baq: 'Euskera', eus: 'Euskera',
  gl: 'Galego', glg: 'Galego',
  ja: '日本語', jpn: '日本語',
  ko: '한국어', kor: '한국어',
  zh: '中文', chi: '中文', zho: '中文',
  ru: 'Русский', rus: 'Русский',
  ar: 'العربية', ara: 'العربية',
  hi: 'हिन्दी', hin: 'हिन्दी',
  tr: 'Türkçe', tur: 'Türkçe',
  pl: 'Polski', pol: 'Polski',
  nl: 'Nederlands', dut: 'Nederlands', nld: 'Nederlands',
  sv: 'Svenska', swe: 'Svenska',
}

export function langLabel(code: string | null | undefined): string | null {
  if (!code) return null
  return LANG_NAMES[code.toLowerCase()] ?? null
}

// Language words inside a file name ("Spanish", "castellano", …).
export function guessLangFromWords(filename: string): string | null {
  const lower = filename.toLowerCase()
  const words: [RegExp, string][] = [
    [/spanish|español|espanol|castellano|latino/, 'es'],
    [/english|ingl[eé]s/, 'en'],
    [/french|franc[eé]s/, 'fr'],
    [/german|alem[aá]n/, 'de'],
    [/italian/, 'it'],
    [/portuguese|portugu[eé]s|brazilian/, 'pt'],
  ]
  for (const [re, code] of words) if (re.test(lower)) return code
  return null
}

// A language hint in a .srt's NAME: an ".es.srt" / ".spa.srt" suffix, or words
// like "Spanish"/"castellano" in the name.
export function guessLangFromName(filename: string): string | null {
  const suffix = filename.match(/\.([a-z]{2,3})\.srt$/i)
  if (suffix && langLabel(suffix[1])) return suffix[1].toLowerCase()
  return guessLangFromWords(filename)
}

// Labels audio tracks with no declared language ('und'). With ONE track it can
// be inferred: words from the file name (a "castellano" rip is a dub) or, failing
// that, the original language according to TMDB. With several unlabelled tracks
// there is no guessing (no way to tell which is which).
export function enrichAudioLangs<T extends { lang: string; label: string }>(
  audio: T[], filename: string, originalLang: string | null,
): T[] {
  if (audio.length !== 1) return audio
  return audio.map(a => {
    if (a.lang !== 'und') return a
    const hint = guessLangFromWords(filename) ?? originalLang
    if (!hint || !langLabel(hint)) return a
    return { ...a, lang: hint, label: langLabel(hint)! }
  })
}

// Content-based language heuristic (distinctive stopwords). Good enough to label
// subtitles that carry no metadata; returns null when there is no clear signal.
const PROFILES: [string, RegExp][] = [
  ['en', /\b(the|and|you|what|with|have|this|that|was|were)\b/gi],
  ['es', /\b(que|los|las|est[aá]|pero|porque|se[ñn]or|gracias|s[ií]|c[oó]mo|m[aá]s|cuando)\b/gi],
  ['fr', /\b(les|vous|est|pas|je|nous|mais|c'est|avec|dans)\b/gi],
  ['de', /\b(und|ich|nicht|das|ist|sie|wir|ein|haben|aber)\b/gi],
  ['it', /\b(che|non|per|una|sono|questo|come|ma|di|cosa)\b/gi],
  ['pt', /\b(n[aã]o|voc[eê]|uma|para|isso|est[aá]|mas|como|ele)\b/gi],
]

export function detectLangFromText(sample: string): string | null {
  const scores = PROFILES.map(([code, re]) => {
    const n = (sample.match(re) ?? []).length
    re.lastIndex = 0
    return { code, n }
  }).sort((a, b) => b.n - a.n)
  const [first, second] = scores
  if (first.n >= 5 && first.n > second.n * 1.3) return first.code
  return null
}
