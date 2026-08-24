// The reactions bar's shortcuts, chosen by each viewer.
// This module deliberately does NOT touch localStorage: Vitest runs in a node
// environment, where it does not exist. The component reads and writes the key;
// only pure logic lives here, and that is what gets tested. Same split as
// parseStoredVolume.

export const QUICK_KEY = 'jbg-quick-emojis'

// A necessary cap: in fullscreen the bar is a single row inside a narrow panel.
export const MAX_QUICK = 12

export const DEFAULT_QUICK = ['😂', '❤️', '😱', '🤯', '🍿', '🔥', '👏', '😭', '💀', '🙈']

export function parseQuick(raw: string | null): string[] {
  if (raw === null) return DEFAULT_QUICK
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return DEFAULT_QUICK }
  if (!Array.isArray(parsed)) return DEFAULT_QUICK
  // An empty list is a legitimate choice and is respected; it is only
  // repopulated when nothing is stored or what is stored is unusable.
  return [...new Set(parsed.filter((e): e is string => typeof e === 'string' && e !== ''))].slice(0, MAX_QUICK)
}

export function addQuick(list: string[], emoji: string): string[] {
  if (list.includes(emoji) || list.length >= MAX_QUICK) return list
  return [...list, emoji]
}

export function removeQuick(list: string[], emoji: string): string[] {
  return list.filter(e => e !== emoji)
}
