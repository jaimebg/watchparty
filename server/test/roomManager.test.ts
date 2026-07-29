import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomManager } from '../src/rooms/roomManager.js'
import { scanLibrary } from '../src/library/scanner.js'
import { makeFixtureMkv } from './support/fixture.js'

const fakeSession = () => ({
  start: () => {}, seekTo: () => {}, stop: async () => {}, onError: () => {},
  lastLog: [] as string[],
  requestSegment: async () => '',
  requestInit: async () => '',
})

let rooms: RoomManager
let items: Awaited<ReturnType<typeof scanLibrary>>

beforeAll(async () => {
  process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'rm-'))
  const mediaDir = mkdtempSync(join(tmpdir(), 'rmmedia-'))
  await makeFixtureMkv(mediaDir)
  rooms = new RoomManager({ createSession: () => fakeSession() })
  items = await scanLibrary([mediaDir])
})

describe('RoomManager.retry', () => {
  // Un snapshot de la ejecución rota que sobreviviera al reintento se serviría
  // para siempre: requestInit corta en cuanto ve el .stable.mp4 en disco.
  it('deletes stale init snapshots so a broken run cannot survive the retry', async () => {
    const room = await rooms.create(items[0])
    const stale = join(room.roomDir, 'init_0.stable.mp4')
    writeFileSync(stale, 'roto')
    const previous = room.session

    await rooms.retry(room.token)

    expect(existsSync(stale)).toBe(false)
    expect(room.session).not.toBe(previous)
  })
})
