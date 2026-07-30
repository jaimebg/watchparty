// Accesos rápidos de la barra de reacciones, elegidos por cada espectador.
// Este módulo NO toca localStorage a propósito: Vitest corre en entorno node,
// donde no existe. El componente lee y escribe la clave; aquí solo hay lógica
// pura, que es lo que se prueba. Mismo reparto que parseStoredVolume.

export const QUICK_KEY = 'jbg-quick-emojis'

// Tope necesario: en pantalla completa la barra es una fila única dentro de un
// panel estrecho.
export const MAX_QUICK = 12

export const DEFAULT_QUICK = ['😂', '❤️', '😱', '🤯', '🍿', '🔥', '👏', '😭', '💀', '🙈']

export function parseQuick(raw: string | null): string[] {
  if (raw === null) return DEFAULT_QUICK
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return DEFAULT_QUICK }
  if (!Array.isArray(parsed)) return DEFAULT_QUICK
  // Una lista vacía es una elección legítima y se respeta; solo se repuebla
  // cuando no hay nada guardado o lo guardado es inservible.
  return [...new Set(parsed.filter((e): e is string => typeof e === 'string' && e !== ''))].slice(0, MAX_QUICK)
}

export function addQuick(list: string[], emoji: string): string[] {
  if (list.includes(emoji) || list.length >= MAX_QUICK) return list
  return [...list, emoji]
}

export function removeQuick(list: string[], emoji: string): string[] {
  return list.filter(e => e !== emoji)
}
