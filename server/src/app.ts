import Fastify, { FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import type { Config } from './config.js'
import type { LibraryItem } from './library/scanner.js'
import type { RoomManager } from './rooms/roomManager.js'
import { registerApi } from './http/api.js'

export interface AppDeps {
  config: Config
  library: () => Promise<LibraryItem[]>
  rooms: RoomManager
  adminToken: string
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  app.get('/health', async () => ({ ok: true }))
  registerApi(app, deps)
  return app
}
