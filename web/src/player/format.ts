export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

// The volume slider's cap: 100% is the <video>'s native volume and from there to
// 200% a Web Audio GainNode amplifies.
export const MAX_VOLUME = 2

// Volume stored in localStorage → a safe number in [0, MAX_VOLUME] (default 1).
export function parseStoredVolume(raw: string | null): number {
  const n = Number(raw)
  if (raw === null || raw === '' || Number.isNaN(n)) return 1
  return Math.min(MAX_VOLUME, Math.max(0, n))
}

// The volume slider's fill. The amplified stretch (>100%) is painted a different
// colour so it is obvious at a glance that the audio is past its native level.
export function volumeGradient(v: number): string {
  const pct = (Math.min(MAX_VOLUME, Math.max(0, v)) / MAX_VOLUME) * 100
  const unity = 100 / MAX_VOLUME
  return pct <= unity
    ? `linear-gradient(90deg, var(--seek-fill) ${pct}%, var(--seek-track) ${pct}%)`
    : `linear-gradient(90deg, var(--seek-fill) ${unity}%, var(--boost-fill) ${unity}%, var(--boost-fill) ${pct}%, var(--seek-track) ${pct}%)`
}

// Does the space key belong to the focused element (typing/activating) rather
// than to the global play/pause toggle? BUTTON included: space = click the button.
export function spaceBelongsTo(tagName?: string, inputType?: string, isContentEditable?: boolean): boolean {
  if (isContentEditable) return true
  if (tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON') return true
  if (tagName === 'INPUT') return inputType !== 'range'
  return false
}

// A seek requested from the bar, clamped to the real runtime before it travels
// over the socket. The server clamps too, but sending an out-of-range value would
// make the room jump somewhere other than where the thumb was released.
export function clampPosition(value: number, durationSec: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(Math.max(value, 0), Math.max(0, durationSec))
}

// The position bar's fill. An input[type=range] takes no child to act as a fill,
// so it is painted with a background gradient, like the volume slider.
export function positionGradient(position: number, durationSec: number): string {
  const pct = durationSec > 0 ? (clampPosition(position, durationSec) / durationSec) * 100 : 0
  return `linear-gradient(90deg, var(--seek-fill) ${pct}%, var(--seek-track) ${pct}%)`
}

// Is the focused element receiving text? Single-letter shortcuts (F = fullscreen)
// must not fire while someone is typing in the chat. `spaceBelongsTo` will not
// do: it counts BUTTON as the owner because space presses the focused button, but
// F does have to work there.
export function isTypingTarget(tagName?: string, inputType?: string, isContentEditable?: boolean): boolean {
  if (isContentEditable) return true
  if (tagName === 'TEXTAREA' || tagName === 'SELECT') return true
  if (tagName === 'INPUT') return inputType !== 'range'
  return false
}
