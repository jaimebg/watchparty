// Server-side strings that travel to a browser (API errors, the native folder
// picker, the placeholder title of an empty room). The client advertises its
// detected language in `accept-language`; anything that is not Spanish is
// English. The setup/preflight CLI keeps speaking English: it is host-facing
// console output, not part of the UI.

export type Lang = 'en' | 'es'

// Same rule as the web's detector: the first tag speaking a supported language
// wins, quality values ignored (the browser's own order already is the
// preference order). Anything unsupported falls back to English.
export function langFromAcceptLanguage(header?: string): Lang {
  for (const part of (header ?? '').split(',')) {
    const base = part.trim().toLowerCase().split(/[-_;]/)[0]
    if (base === 'es') return 'es'
    if (base === 'en') return 'en'
  }
  return 'en'
}

const en = {
  'error.pathRequired': 'path required',
  'error.pathNotFound': 'path not found: {path}',
  'error.notAFolder': 'not a folder: {path}',
  'error.itemNotFound': 'item not found',
  'error.pathOutside': 'path outside media folders',
  'error.roomNotFound': 'room not found',
  'error.roomBusy': 'room busy',
  'error.roomNoMedia': 'room has no media',
  'error.retryCooldown': 'retry cooldown',
  'status.noMovie': 'No movie',
  'prompt.pickFolder': 'Pick your media folder',
} as const

export type MsgKey = keyof typeof en

const es: Record<MsgKey, string> = {
  'error.pathRequired': 'ruta requerida',
  'error.pathNotFound': 'la ruta no existe: {path}',
  'error.notAFolder': 'la ruta no es una carpeta: {path}',
  'error.itemNotFound': 'elemento no encontrado',
  'error.pathOutside': 'la ruta está fuera de las carpetas de medios',
  'error.roomNotFound': 'sala no encontrada',
  'error.roomBusy': 'la sala está ocupada',
  'error.roomNoMedia': 'la sala no tiene película',
  'error.retryCooldown': 'reintento demasiado pronto',
  'status.noMovie': 'Sin película',
  'prompt.pickFolder': 'Elige tu carpeta de medios',
}

const messages: Record<Lang, Record<MsgKey, string>> = { en, es }

export function serverMessage(lang: Lang, key: MsgKey, vars?: Record<string, string | number>): string {
  const text = messages[lang][key]
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}
