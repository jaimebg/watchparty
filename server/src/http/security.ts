import { resolve, sep } from 'node:path'
import type { FastifyReply, FastifyRequest } from 'fastify'
import '@fastify/cookie'

export function isPathInside(root: string, p: string): boolean {
  const r = resolve(root), t = resolve(p)
  return t === r || t.startsWith(r + sep)
}

export function makeRequireAdmin(adminToken: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const q = (req.query as Record<string, string>)?.key
    const cookie = req.cookies?.admin
    if (q === adminToken) { reply.setCookie('admin', adminToken, { path: '/', httpOnly: true }); return }
    if (cookie !== adminToken) reply.code(401).send({ error: 'admin required' })
  }
}
