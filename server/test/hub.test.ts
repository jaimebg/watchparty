import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import WebSocket from 'ws'
import { buildApp } from '../src/app.js'
import { RoomManager } from '../src/rooms/roomManager.js'
import { makeFixtureMkv } from './support/fixture.js'
import { scanLibrary } from '../src/library/scanner.js'
import { stallTiming } from '../src/rooms/stallControl.js'

let app: Awaited<ReturnType<typeof buildApp>>, url: string, token: string
let rooms: RoomManager
let items: Awaited<ReturnType<typeof scanLibrary>>

// A fresh fake session per room (rather than one shared object) so each
// room's onError callback and error trigger stay independent of the others.
function makeFakeSession() {
  let errorCb: ((log: string[]) => void) | null = null
  return {
    start: () => {}, seekTo: () => {}, stop: async () => {},
    onError: (cb: (log: string[]) => void) => { errorCb = cb },
    triggerError: (log: string[]) => errorCb?.(log),
    lastLog: [] as string[],
    requestSegment: async () => '/dev/null',
    openSegment: async () => Readable.from([]),
    requestInit: async () => '/dev/null',
  }
}

function connect(name: string, tok = token): Promise<{ ws: WebSocket; recv: () => Promise<any> }> {
  return new Promise((res) => {
    const ws = new WebSocket(`${url}/ws/${tok}`)
    const queue: any[] = []; const waiters: ((m: any) => void)[] = []
    ws.on('message', d => { const m = JSON.parse(d.toString()); const w = waiters.shift(); w ? w(m) : queue.push(m) })
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', name })); res({ ws, recv: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(r => waiters.push(r)) }) })
  })
}

beforeAll(async () => {
  process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'hub-'))
  const mediaDir = mkdtempSync(join(tmpdir(), 'hubmedia-'))
  await makeFixtureMkv(mediaDir)
  rooms = new RoomManager({ createSession: () => makeFakeSession() })
  app = await buildApp({
    config: { mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'H', cacheLimitGB: 10 },
    library: () => scanLibrary([mediaDir]), rooms, adminToken: 'a', tunnel: { url: null },
  })
  await app.listen({ port: 0 })
  const port = (app.server.address() as any).port
  url = `ws://127.0.0.1:${port}`
  items = await scanLibrary([mediaDir])
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

  it('malformed client messages are ignored, not fatal, and later valid messages still work', async () => {
    const a = await connect('Mara')
    await a.recv() // welcome
    await a.recv() // presence propio
    await a.recv() // system "Mara se unió"
    const b = await connect('Nico')
    await b.recv() // welcome de Nico
    await a.recv(); await a.recv() // presence + system de Nico en A
    await b.recv(); await b.recv() // presence + system en B

    // Each of these has a wrong/missing shape for its type and must be ignored in
    // silence (no throw, no crash, no broadcast) rather than kill the process.
    a.ws.send(JSON.stringify({ t: 'join' })) // missing name
    a.ws.send(JSON.stringify({ t: 'chat' })) // missing text
    a.ws.send(JSON.stringify({ t: 'seek', position: 'x' })) // wrong type
    a.ws.send(JSON.stringify({ t: 'desconocido' })) // unknown type

    // The server must still be alive and functional after the garbage above.
    a.ws.send(JSON.stringify({ t: 'chat', text: 'sigo vivo' }))
    const chatB = await b.recv()
    expect(chatB.entry.text).toBe('sigo vivo')

    a.ws.close(); b.ws.close()
  })

  it('seek position is clamped to [0, durationSec] before being applied', async () => {
    // Uses its own room rather than the shared `token` one: reusing a room
    // right after a previous test closed its sockets races the server-side
    // close handlers (which broadcast presence/system to remaining peers)
    // against this test's own initial recv() calls.
    const room = await rooms.create(items[0])
    const duration = room.info.durationSec
    const a = await connect('Clara', room.token)
    await a.recv(); await a.recv(); await a.recv() // welcome, presence, system "se unió"

    a.ws.send(JSON.stringify({ t: 'seek', position: 999999 }))
    const overMsgs = [await a.recv(), await a.recv()]
    const overState = overMsgs.find(m => m.t === 'state')!
    expect(overState.state.positionBase).toBeCloseTo(duration)

    a.ws.send(JSON.stringify({ t: 'seek', position: -5 }))
    const underMsgs = [await a.recv(), await a.recv()]
    const underState = underMsgs.find(m => m.t === 'state')!
    expect(underState.state.positionBase).toBe(0)

    a.ws.close()
  })

  it('an ffmpeg error mid-session is broadcast to every connected client as {t:"error"}', async () => {
    const room = await rooms.create(items[0])
    const a = await connect('Edi', room.token)
    await a.recv(); await a.recv(); await a.recv() // welcome, presence, system "se unió"
    const b = await connect('Uve', room.token)
    await b.recv() // welcome de Uve (incluye history)
    await a.recv(); await a.recv() // presence + system de Uve, en A
    await b.recv(); await b.recv() // presence + system, en B

    ;(room.session as unknown as { triggerError: (log: string[]) => void }).triggerError(['ffmpeg: boom'])
    const errA = await a.recv()
    const errB = await b.recv()
    expect(errA).toEqual({ t: 'error', log: ['ffmpeg: boom'] })
    expect(errB).toEqual({ t: 'error', log: ['ffmpeg: boom'] })

    a.ws.close(); b.ws.close()
  })

  it('closing a room (DELETE /api/rooms/:token) closes every live socket with code 4001', async () => {
    const room = await rooms.create(items[0])
    const a = await connect('Zoe', room.token)
    await a.recv(); await a.recv(); await a.recv() // welcome, presence, system "se unió"

    const closed = new Promise<{ code: number; reason: string }>(resolve => {
      a.ws.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }))
    })

    const res = await app.inject({ method: 'DELETE', url: `/api/rooms/${room.token}`, cookies: { admin: 'a' } })
    expect(res.statusCode).toBe(200)

    const { code, reason } = await closed
    expect(code).toBe(4001)
    expect(reason).toBe('room closed')
  })

  it('a disconnect while buffering broadcasts buffering:false so the indicator does not stick', async () => {
    const room = await rooms.create(items[0])
    const a = await connect('Pau', room.token)
    await a.recv(); await a.recv(); await a.recv() // welcome, presence, system "se unió"
    const b = await connect('Rita', room.token)
    await b.recv() // welcome
    await a.recv(); await a.recv() // presence + system de Rita, en A
    await b.recv(); await b.recv() // presence + system, en B

    a.ws.send(JSON.stringify({ t: 'buffering', value: true }))
    const onMsgs = [await b.recv(), await b.recv()] // buffering + state (la sala se congela)
    expect(onMsgs.find(m => m.t === 'buffering')).toEqual({ t: 'buffering', name: 'Pau', value: true })

    a.ws.close()
    const offMsgs = [await b.recv(), await b.recv()] // buffering + state (la sala se reanuda)
    expect(offMsgs.find(m => m.t === 'buffering')).toEqual({ t: 'buffering', name: 'Pau', value: false })

    b.ws.close()
  })

  it('a buffering viewer freezes the room clock and the last ready one resumes it', async () => {
    // Sala propia: reusar una de otro test corre contra sus close handlers.
    const room = await rooms.create(items[0])
    const a = await connect('Iker', room.token)
    await a.recv(); await a.recv(); await a.recv() // welcome, presence, system
    const b = await connect('Sol', room.token)
    await b.recv() // welcome de Sol
    await a.recv(); await a.recv() // presence + system de Sol, en A
    await b.recv(); await b.recv() // presence + system, en B

    a.ws.send(JSON.stringify({ t: 'buffering', value: true }))
    const afterBuf = [await b.recv(), await b.recv()]
    expect(afterBuf.find(m => m.t === 'buffering')).toEqual({ t: 'buffering', name: 'Iker', value: true })
    expect(afterBuf.find(m => m.t === 'state')!.state.stalled).toBe(true)

    a.ws.send(JSON.stringify({ t: 'buffering', value: false }))
    const afterReady = [await b.recv(), await b.recv()]
    expect(afterReady.find(m => m.t === 'state')!.state.stalled).toBe(false)

    a.ws.close(); b.ws.close()
  })

  it('the room resumes on its own once the stall cap expires', async () => {
    const cap = stallTiming.capMs, cooldown = stallTiming.cooldownMs
    stallTiming.capMs = 150
    stallTiming.cooldownMs = 150
    try {
      const room = await rooms.create(items[0])
      const a = await connect('Noa', room.token)
      await a.recv(); await a.recv(); await a.recv() // welcome, presence, system

      a.ws.send(JSON.stringify({ t: 'buffering', value: true }))
      const frozen = [await a.recv(), await a.recv()]
      expect(frozen.find(m => m.t === 'state')!.state.stalled).toBe(true)

      // Nunca envía buffering:false: la sala debe salir sola por el tope.
      const resumed = await a.recv()
      expect(resumed.t).toBe('state')
      expect(resumed.state.stalled).toBe(false)

      a.ws.close()
    } finally {
      stallTiming.capMs = cap
      stallTiming.cooldownMs = cooldown
    }
  })

  it('a visibility message updates the participant and rebroadcasts full presence', async () => {
    // Sala propia para no correr contra los close handlers de tests anteriores
    // (mismo motivo que el test de seek clamp).
    const room = await rooms.create(items[0])
    const a = await connect('Vera', room.token)
    const wA = await a.recv()
    expect(wA.t).toBe('welcome')
    expect(wA.self.active).toBe(true)
    await a.recv(); await a.recv() // presence propio + system "se unió"
    const b = await connect('Beto', room.token)
    const wB = await b.recv() // welcome de Beto
    expect(wB.participants.every((p: any) => p.active === true)).toBe(true)
    await a.recv(); await a.recv() // presence + system de Beto, en A
    await b.recv(); await b.recv() // presence + system, en B

    a.ws.send(JSON.stringify({ t: 'visibility', active: false }))
    const presB = await b.recv()
    expect(presB.t).toBe('presence')
    expect(presB.participants.find((p: any) => p.name === 'Vera').active).toBe(false)
    expect(presB.participants.find((p: any) => p.name === 'Beto').active).toBe(true)

    // Un payload malformado se ignora en silencio; el siguiente válido sí llega.
    a.ws.send(JSON.stringify({ t: 'visibility', active: 'x' }))
    a.ws.send(JSON.stringify({ t: 'visibility', active: true }))
    const presB2 = await b.recv()
    expect(presB2.t).toBe('presence')
    expect(presB2.participants.find((p: any) => p.name === 'Vera').active).toBe(true)

    a.ws.close(); b.ws.close()
  })
})
