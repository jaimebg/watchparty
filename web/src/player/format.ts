export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

// ¿La tecla espacio pertenece al elemento con foco (escribir/activar) en vez de
// al toggle global de play/pausa? BUTTON incluido: espacio = click del botón.
export function spaceBelongsTo(tagName?: string, inputType?: string, isContentEditable?: boolean): boolean {
  if (isContentEditable) return true
  if (tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON') return true
  if (tagName === 'INPUT') return inputType !== 'range'
  return false
}
