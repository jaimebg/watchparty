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

  // Un .m4s o un init_*.mp4 vivo de la ejecución rota puede hacer creer a
  // requestInit() de la sesión nueva que su propio init ya está completo (ver
  // transcoder.ts), y si el reintento pasó de copy a transcode ese init viejo
  // trae el SPS/PPS de la fuente mientras los segmentos nuevos llevan los de
  // libx264. Los subtítulos extraídos siguen siendo válidos: un reintento no
  // los regenera, así que deben sobrevivir.
  it('deletes stale segments and init files but keeps extracted subtitles', async () => {
    const room = await rooms.create(items[0])
    const staleSegment = join(room.roomDir, 'seg_0_00000.m4s')
    const staleInit = join(room.roomDir, 'init_0.mp4')
    const staleSub = join(room.roomDir, 'sub_0.vtt')
    writeFileSync(staleSegment, 'roto')
    writeFileSync(staleInit, 'roto')
    writeFileSync(staleSub, 'WEBVTT\n')

    await rooms.retry(room.token)

    expect(existsSync(staleSegment)).toBe(false)
    expect(existsSync(staleInit)).toBe(false)
    expect(existsSync(staleSub)).toBe(true)
  })
})
