// Los tokens reales son 22 caracteres base64url (randomBytes(16) en
// server/src/rooms/roomManager.ts) y el enrutado de App.tsx acepta [\w-]+.
// El mínimo de 8 es solo un suelo de cordura para no navegar a basura.
const TOKEN_RE = /^[\w-]{8,}$/

// Acepta tanto el código pelado como un enlace de sala pegado entero, que es lo
// que el host comparte y lo que el invitado tiene a mano en el portapapeles.
export function parseRoomToken(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const fromUrl = trimmed.match(/\/room\/([\w-]+)/)
  const candidate = fromUrl ? fromUrl[1] : trimmed
  return TOKEN_RE.test(candidate) ? candidate : null
}

// Enlace que el host comparte. El origen puede venir de config.json escrito a
// mano (túnel con nombre), así que la barra final se normaliza aquí en vez de
// colar un `//room/…` en el enlace que se reparte por WhatsApp.
export function roomLink(origin: string, token: string): string {
  return `${origin.trim().replace(/\/+$/, '')}/room/${token}`
}
