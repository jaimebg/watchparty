import Fastify, { FastifyInstance } from 'fastify'

export interface AppDeps {}

export async function buildApp(_deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.get('/health', async () => ({ ok: true }))
  return app
}
