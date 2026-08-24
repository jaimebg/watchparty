import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify, { FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import type { Config } from './config.js'
import type { LibraryItem } from './library/scanner.js'
import type { RoomManager } from './rooms/roomManager.js'
import { registerApi } from './http/api.js'
import { registerHub } from './ws/hub.js'
import { registerKlipy } from './http/klipy.js'

export interface AppDeps {
  config: Config
  library: () => Promise<LibraryItem[]>
  rooms: RoomManager
  adminToken: string
  tunnel: { url: string | null }
  fetchImpl?: typeof fetch
  pickFolder?: () => Promise<string | null>
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  await app.register(websocket)
  app.get('/health', async () => ({ ok: true }))
  registerApi(app, deps)
  registerHub(app, deps)
  registerKlipy(app, deps)

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
  if (existsSync(webDist)) {
    // wildcard:true resolves files ON EVERY REQUEST (rather than with a glob at
    // boot): rebuilding web/dist with new hashes works without a restart.
    await app.register(fastifyStatic, { root: webDist, wildcard: true })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/stream') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not found' })
      }
      // A missing asset (say, a bundle with an old hash) has to fail with a real
      // 404: serving index.html as if it were JS kills the app silently.
      const path = req.url.split('?')[0]
      if (path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(path)) {
        return reply.code(404).send({ error: 'not found' })
      }
      return reply.sendFile('index.html', webDist)
    })
  }

  return app
}
