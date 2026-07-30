export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
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

// Un salto pedido desde la barra, recortado al metraje real antes de viajar por
// el socket. El servidor también recorta, pero mandar un valor de fuera de rango
// haría que la sala saltara a un sitio distinto del que soltó el pulgar.
export function clampPosition(value: number, durationSec: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(Math.max(value, 0), Math.max(0, durationSec))
}

// Relleno de la barra de posición. Un input[type=range] no admite un hijo que
// haga de relleno, así que se pinta con un degradado de fondo, igual que el
// slider de volumen.
export function positionGradient(position: number, durationSec: number): string {
  const pct = durationSec > 0 ? (clampPosition(position, durationSec) / durationSec) * 100 : 0
  return `linear-gradient(90deg, var(--seek-fill) ${pct}%, var(--seek-track) ${pct}%)`
}

// ¿El elemento con foco está recibiendo texto? Los atajos de una sola letra
// (F = pantalla completa) no deben dispararse mientras se escribe en el chat.
// No vale `spaceBelongsTo`: esa cuenta BUTTON como propietario porque el
// espacio pulsa el botón enfocado, pero la F sí debe funcionar ahí.
export function isTypingTarget(tagName?: string, inputType?: string, isContentEditable?: boolean): boolean {
  if (isContentEditable) return true
  if (tagName === 'TEXTAREA' || tagName === 'SELECT') return true
  if (tagName === 'INPUT') return inputType !== 'range'
  return false
}
