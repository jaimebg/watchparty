export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

// Inverso de formatClock, para el salto del host: acepta «5220», «87:00» y
// «1:27:00» (y cualquiera con espacios alrededor). Devuelve null si no es
// ninguna de esas formas, en vez de un NaN que acabaría viajando por el socket.
// Cada grupo debe ser un entero sin signo: un «-2» colado en los minutos daría
// un total plausible pero equivocado.
export function parseClock(raw: string): number | null {
  const parts = raw.trim().split(':')
  if (parts.length > 3) return null
  if (!parts.every(p => /^\d+$/.test(p))) return null
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0)
}

// Tope del slider de volumen: el 100% es el volumen nativo del <video> y de ahí
// al 200% amplifica un GainNode de Web Audio.
export const MAX_VOLUME = 2

// Volumen guardado en localStorage → número seguro en [0, MAX_VOLUME] (default 1).
export function parseStoredVolume(raw: string | null): number {
  const n = Number(raw)
  if (raw === null || raw === '' || Number.isNaN(n)) return 1
  return Math.min(MAX_VOLUME, Math.max(0, n))
}

// Relleno del slider de volumen. El tramo amplificado (>100%) se pinta en otro
// color para que se vea de un vistazo que el audio ya no está en su nivel nativo.
export function volumeGradient(v: number): string {
  const pct = (Math.min(MAX_VOLUME, Math.max(0, v)) / MAX_VOLUME) * 100
  const unity = 100 / MAX_VOLUME
  return pct <= unity
    ? `linear-gradient(90deg, var(--seek-fill) ${pct}%, var(--seek-track) ${pct}%)`
    : `linear-gradient(90deg, var(--seek-fill) ${unity}%, var(--boost-fill) ${unity}%, var(--boost-fill) ${pct}%, var(--seek-track) ${pct}%)`
}

// ¿La tecla espacio pertenece al elemento con foco (escribir/activar) en vez de
// al toggle global de play/pausa? BUTTON incluido: espacio = click del botón.
export function spaceBelongsTo(tagName?: string, inputType?: string, isContentEditable?: boolean): boolean {
  if (isContentEditable) return true
  if (tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON') return true
  if (tagName === 'INPUT') return inputType !== 'range'
  return false
}
