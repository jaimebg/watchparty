// Real tokens are 22 base64url characters (randomBytes(16) in
// server/src/rooms/roomManager.ts) and App.tsx's routing accepts [\w-]+.
// The minimum of 8 is just a sanity floor so we do not navigate to garbage.
const TOKEN_RE = /^[\w-]{8,}$/

// It accepts both the bare code and a whole room link pasted in, which is what
// the host shares and what the guest has to hand on the clipboard.
export function parseRoomToken(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const fromUrl = trimmed.match(/\/room\/([\w-]+)/)
  const candidate = fromUrl ? fromUrl[1] : trimmed
  return TOKEN_RE.test(candidate) ? candidate : null
}

// The link the host shares. The origin can come from a hand-written config.json
// (a named tunnel), so the trailing slash is normalized here rather than slipping
// a `//room/…` into the link people pass around.
export function roomLink(origin: string, token: string): string {
  return `${origin.trim().replace(/\/+$/, '')}/room/${token}`
}
