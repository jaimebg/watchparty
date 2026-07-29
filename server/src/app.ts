import Fastify, { FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
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
  fetchImpl?: typeof fetch
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  await app.register(websocket)
  app.get('/health', async () => ({ ok: true }))
  registerApi(app, deps)
  registerHub(app, deps)
  registerKlipy(app, deps)
  return app
}
