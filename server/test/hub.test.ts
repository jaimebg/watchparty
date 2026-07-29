import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { buildApp } from '../src/app.js'
import { RoomManager } from '../src/rooms/roomManager.js'
import { makeFixtureMkv } from './support/fixture.js'
import { scanLibrary } from '../src/library/scanner.js'

let app: Awaited<ReturnType<typeof buildApp>>, url: string, token: string

const fakeSession = {
  start: () => {}, seekTo: () => {}, stop: async () => {}, onError: () => {}, lastLog: [],
  requestSegment: async () => '/dev/null',
}

function connect(name: string): Promise<{ ws: WebSocket; recv: () => Promise<any> }> {
  return new Promise((res) => {
    const ws = new WebSocket(`${url}/ws/${token}`)
    const queue: any[] = []; const waiters: ((m: any) => void)[] = []
    ws.on('message', d => { const m = JSON.parse(d.toString()); const w = waiters.shift(); w ? w(m) : queue.push(m) })
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', name })); res({ ws, recv: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(r => waiters.push(r)) }) })
  })
}

beforeAll(async () => {
  process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'hub-'))
  const mediaDir = mkdtempSync(join(tmpdir(), 'hubmedia-'))
  await makeFixtureMkv(mediaDir)
  const rooms = new RoomManager({ createSession: () => fakeSession })
  app = await buildApp({
    config: { mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'H', cacheLimitGB: 10 },
    library: () => scanLibrary([mediaDir]), rooms, adminToken: 'a',
  })
  await app.listen({ port: 0 })
  const port = (app.server.address() as any).port
  url = `ws://127.0.0.1:${port}`
  const items = await scanLibrary([mediaDir])
  token = (await rooms.create(items[0])).token
})
afterAll(async () => { await app.close() })

describe('hub', () => {
  it('welcome + presence + play propagates state and system message', async () => {
    const a = await connect('Ana')
    const wA = await a.recv()
    expect(wA.t).toBe('welcome')
    expect(wA.self.name).toBe('Ana')
    await a.recv() // presence propio
    await a.recv() // system "Ana se unió"
    const b = await connect('Luis')
    await b.recv() // welcome de Luis (incluye history con "Ana se unió")
    await a.recv(); await a.recv() // presence + system de Luis en A
    await b.recv(); await b.recv() // presence + system en B

    a.ws.send(JSON.stringify({ t: 'play' }))
    const msgsB = [await b.recv(), await b.recv()]
    const state = msgsB.find(m => m.t === 'state')!
    expect(state.state.paused).toBe(false)
    expect(typeof state.serverNow).toBe('number')
    const sys = msgsB.find(m => m.t === 'chat')!
    expect(sys.entry.kind).toBe('system')

    a.ws.send(JSON.stringify({ t: 'chat', text: 'hola' }))
    const chatB = await b.recv()
    expect(chatB.entry.text).toBe('hola')

    a.ws.send(JSON.stringify({ t: 'reaction', emoji: '🔥' }))
    const rB = await b.recv()
    expect(rB).toMatchObject({ t: 'reaction', emoji: '🔥', from: 'Ana' })
    a.ws.close(); b.ws.close()
  })
})
