import { timingSafeEqual } from 'node:crypto'
import { resolve, sep } from 'node:path'
import type { FastifyReply, FastifyRequest } from 'fastify'
import '@fastify/cookie'

export function isPathInside(root: string, p: string): boolean {
  const r = resolve(root), t = resolve(p)
  return t === r || t.startsWith(r + sep)
}

function safeEqual(a: string | undefined, b: string): boolean {
  if (a === undefined || a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export function makeRequireAdmin(adminToken: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const q = (req.query as Record<string, string>)?.key
    const cookie = req.cookies?.admin
    if (safeEqual(q, adminToken)) {
      // no `secure`: admin is accessed over http://localhost by design (guests never get this cookie)
      reply.setCookie('admin', adminToken, { path: '/', httpOnly: true, sameSite: 'strict' })
      return
    }
    if (!safeEqual(cookie, adminToken)) reply.code(401).send({ error: 'admin required' })
  }
}
