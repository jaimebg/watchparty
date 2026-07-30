import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { RoomManager, RoomBusyError } from '../src/rooms/roomManager.js'
import { scanLibrary } from '../src/library/scanner.js'
import { makeFixtureMkv } from './support/fixture.js'

const fakeSession = () => ({
  start: () => {}, seekTo: () => {}, stop: async () => {}, onError: () => {},
  lastLog: [] as string[],
  openSegment: async () => Readable.from([]),
  requestInit: async () => '',
})

let rooms: RoomManager
let items: Awaited<ReturnType<typeof scanLibrary>>
let monoItems: Awaited<ReturnType<typeof scanLibrary>>

beforeAll(async () => {
  process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'rm-'))
  const mediaDir = mkdtempSync(join(tmpdir(), 'rmmedia-'))
  await makeFixtureMkv(mediaDir)
  rooms = new RoomManager({ createSession: () => fakeSession() })
  items = await scanLibrary([mediaDir])
  const monoDir = mkdtempSync(join(tmpdir(), 'rmmono-'))
  await makeFixtureMkv(monoDir, { audioTracks: 1 })
  monoItems = await scanLibrary([monoDir])
})

// La rejilla de segmentos y el modo de ffmpeg son UN solo contrato: en copy el
// vídeo solo se puede cortar en los keyframes de la fuente, y en transcode
// ffmpeg fuerza los suyos cada 4 s (ver ffmpegArgs.ts). Planificar con la
// rejilla equivocada hace que la playlist describa cortes que el archivo no
// tiene, que es justo lo que rompía el audio.
describe('RoomManager.create plans the grid the chosen mode will actually produce', () => {
  const capturing = () => {
    const modes: ('copy' | 'transcode')[] = []
    const manager = new RoomManager({
      createSession: (_i, _info, _segs, _dir, mode) => { modes.push(mode); return fakeSession() },
    })
    return { manager, modes }
  }

  it('plans the uniform 4s grid ffmpeg will force, for one audio track', async () => {
    const { manager, modes } = capturing()
    const room = await manager.create(monoItems[0])
    expect(modes).toEqual(['transcode'])
    expect(room.media!.segments.map(s => s.start)).toEqual([0, 4, 8])
  })

  it('plans the uniform 4s grid ffmpeg will force, for several audio tracks', async () => {
    const { manager, modes } = capturing()
    const room = await manager.create(items[0])
    expect(modes).toEqual(['transcode'])
    expect(room.media!.segments.map(s => s.start)).toEqual([0, 4, 8])
  })

  // Los keyframes de la FUENTE ya no deciden nada: ffmpeg va a poner los suyos
  // cada 4 s. Planificar con ellos era justo lo que producía una playlist con
  // menos segmentos de los que ffmpeg escribía.
  it('does not let the source keyframes shape the grid', async () => {
    const { manager } = capturing()
    const room = await manager.create(monoItems[0])
    for (const s of room.media!.segments.slice(0, -1)) expect(s.duration).toBe(4)
    for (const s of room.media!.segments) expect(s.seekAt).toBe(s.start)
  })
})

describe('RoomManager.retry', () => {
  // Un snapshot de la ejecución rota que sobreviviera al reintento se serviría
  // para siempre: requestInit corta en cuanto ve el .stable.mp4 en disco.
  it('deletes stale init snapshots so a broken run cannot survive the retry', async () => {
    const room = await rooms.create(items[0])
    const stale = join(room.media!.dir, 'init_0.stable.mp4')
    writeFileSync(stale, 'roto')
    const previous = room.media!.session

    await rooms.retry(room.token)

    expect(existsSync(stale)).toBe(false)
    expect(room.media!.session).not.toBe(previous)
  })

  // Un .m4s o un init_*.mp4 vivo de la ejecución rota puede hacer creer a
  // requestInit() de la sesión nueva que su propio init ya está completo (ver
  // transcoder.ts), y si el reintento pasó de copy a transcode ese init viejo
  // trae el SPS/PPS de la fuente mientras los segmentos nuevos llevan los de
  // libx264. Los subtítulos extraídos siguen siendo válidos: un reintento no
  // los regenera, así que deben sobrevivir.
  it('deletes stale segments and init files but keeps extracted subtitles', async () => {
    const room = await rooms.create(items[0])
    const staleSegment = join(room.media!.dir, 'seg_0_00000.m4s')
    const staleInit = join(room.media!.dir, 'init_0.mp4')
    const staleSub = join(room.media!.dir, 'sub_0.vtt')
    writeFileSync(staleSegment, 'roto')
    writeFileSync(staleInit, 'roto')
    writeFileSync(staleSub, 'WEBVTT\n')

    await rooms.retry(room.token)

    expect(existsSync(staleSegment)).toBe(false)
    expect(existsSync(staleInit)).toBe(false)
    expect(existsSync(staleSub)).toBe(true)
  })

  // El reintento vuelve a montar la sesión desde cero, y la rejilla que sirva
  // la sala tras él tiene que seguir siendo la que ffmpeg va a producir.
  it('re-plans the grid, so the playlist keeps matching what the new run will cut', async () => {
    const modes: ('copy' | 'transcode')[] = []
    const manager = new RoomManager({
      createSession: (_i, _info, _segs, _dir, mode) => { modes.push(mode); return fakeSession() },
    })
    const room = await manager.create(monoItems[0])

    await manager.retry(room.token)

    expect(modes).toEqual(['transcode', 'transcode'])
    expect(room.media!.segments.map(s => s.start)).toEqual([0, 4, 8])
  })
})

describe('RoomManager sin película', () => {
  it('crea la sala sin tocar ffmpeg ni ffprobe', async () => {
    let sessions = 0
    const manager = new RoomManager({ createSession: () => { sessions++; return fakeSession() } })

    const room = await manager.create()

    expect(room.media).toBeNull()
    expect(sessions).toBe(0)
    expect(room.state.paused).toBe(true)
    expect(room.state.positionBase).toBe(0)
    expect(existsSync(room.dir)).toBe(true)
  })

  it('setMedia puebla info, segmentos, subtítulos y metadatos, y arranca en epoch 1', async () => {
    const meta = { title: 'Peli', year: 2020, overview: '', posterUrl: null, rating: null, episodeTag: null, originalLang: 'en' }
    const manager = new RoomManager({ createSession: () => fakeSession(), lookupMeta: async () => meta })
    const room = await manager.create()

    const media = await manager.setMedia(room.token, items[0], 'Jaime')

    expect(media.epoch).toBe(1)
    expect(media.setBy).toBe('Jaime')
    expect(media.info.audio).toHaveLength(2)
    expect(media.segments.map(s => s.start)).toEqual([0, 4, 8])
    expect(media.subtitles.length).toBeGreaterThanOrEqual(1)
    expect(media.meta).toEqual(meta)
    expect(room.media).toBe(media)
    // Todo lo de la película vive en el directorio del epoch, no en la raíz de
    // la sala: es lo que permite tirar la generación anterior de un rmSync.
    expect(media.dir).toBe(join(room.dir, 'e1'))
  })

  it('el segundo setMedia sube el epoch, para la sesión vieja y borra su directorio', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    const first = room.media!
    let stopped = false
    first.session.stop = async () => { stopped = true }
    // Marca en el directorio viejo: si sobreviviera, requestInit de la sesión
    // nueva podría servir un init de la película anterior.
    writeFileSync(join(first.dir, 'init_0.stable.mp4'), 'viejo')

    const second = await manager.setMedia(room.token, monoItems[0])

    expect(stopped).toBe(true)
    expect(second.epoch).toBe(2)
    expect(second.dir).toBe(join(room.dir, 'e2'))
    expect(existsSync(first.dir)).toBe(false)
    expect(second.setBy).toBeNull()
  })

  it('resetea la reproducción y el error al cambiar de película', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    room.state = { paused: false, positionBase: 500, updatedAt: 1, stalled: true }
    room.error = ['ffmpeg: boom']

    await manager.setMedia(room.token, monoItems[0])

    expect(room.state.paused).toBe(true)
    expect(room.state.positionBase).toBe(0)
    expect(room.state.stalled).toBe(false)
    expect(room.error).toBeNull()
  })

  it('notifica a los mediaListeners con el medio nuevo', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create()
    const seen: number[] = []
    room.mediaListeners.add(m => seen.push(m.epoch))

    await manager.setMedia(room.token, items[0])
    await manager.setMedia(room.token, monoItems[0])

    expect(seen).toEqual([1, 2])
  })

  // Si el fan-out no protege cada llamada por separado, un listener roto se
  // lleva por delante a los que van detrás de él en el Set: el cambio de
  // película ya ocurrió (room.media es el nuevo) pero nadie después del roto
  // se entera.
  it('un mediaListener que lanza no impide que setMedia resuelva ni que los demás se enteren', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create()
    const seenByOther: number[] = []
    room.mediaListeners.add(() => { throw new Error('listener roto') })
    room.mediaListeners.add(m => seenByOther.push(m.epoch))

    const media = await manager.setMedia(room.token, items[0])

    expect(media.epoch).toBe(1)
    expect(room.media).toBe(media)
    expect(seenByOther).toEqual([1])
  })

  // Un fichero que ffprobe no puede leer no debe dejar la sala a medias: la
  // película anterior tiene que seguir sonando y el directorio nuevo no debe
  // quedarse tirado en la caché.
  it('un fichero ilegible deja intacta la película anterior', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    const before = room.media!
    let stopped = false
    // Si prepareMedia se ejecutara después de parar la sesión vieja (en vez de
    // antes), este test seguiría en verde con la sala muda: por eso se
    // instrumenta stop() y se comprueba que NUNCA se llama.
    before.session.stop = async () => { stopped = true }
    const brokenDir = mkdtempSync(join(tmpdir(), 'rmbroken-'))
    writeFileSync(join(brokenDir, 'roto.mkv'), 'esto no es un vídeo')
    const broken = (await scanLibrary([brokenDir]))[0]

    await expect(manager.setMedia(room.token, broken)).rejects.toThrow()

    expect(room.media).toBe(before)
    expect(room.media!.epoch).toBe(1)
    expect(existsSync(before.dir)).toBe(true)
    expect(existsSync(join(room.dir, 'e2'))).toBe(false)
    expect(stopped).toBe(false)
  })

  it('rechaza un segundo cambio mientras hay uno en vuelo', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create()

    const first = manager.setMedia(room.token, items[0])
    await expect(manager.setMedia(room.token, monoItems[0])).rejects.toBeInstanceOf(RoomBusyError)
    await first

    expect(room.media!.epoch).toBe(1)
  })

  it('libera busy tras un setMedia fallido: el siguiente intento con un fichero bueno funciona', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    const brokenDir = mkdtempSync(join(tmpdir(), 'rmbroken3-'))
    writeFileSync(join(brokenDir, 'roto.mkv'), 'esto no es un vídeo')
    const broken = (await scanLibrary([brokenDir]))[0]

    await expect(manager.setMedia(room.token, broken)).rejects.toThrow()
    const media = await manager.setMedia(room.token, monoItems[0])

    expect(media.epoch).toBe(2)
  })

  // busy es el único cerrojo compartido entre setMedia y retry: si retry no lo
  // levantara, esta dirección (retry en vuelo → setMedia) no se rechazaría y
  // las dos sesiones acabarían compitiendo por el mismo directorio.
  it('un retry en vuelo bloquea un setMedia con RoomBusyError', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const room = await manager.create(items[0])
    let releaseStop: () => void = () => {}
    // stop() se queda colgado a propósito: como room.busy se pone a true de
    // forma síncrona antes de este await (mismo patrón que setMedia), el
    // retry ya ha marcado la sala como ocupada en cuanto esta línea retorna,
    // sin depender de temporizadores ni de sleep.
    room.media!.session.stop = () => new Promise<void>(resolve => { releaseStop = resolve })

    const retrying = manager.retry(room.token)
    await expect(manager.setMedia(room.token, monoItems[0])).rejects.toBeInstanceOf(RoomBusyError)

    releaseStop()
    await retrying
  })

  it('retry es no-op sin película y close funciona sin ella', async () => {
    let sessions = 0
    const manager = new RoomManager({ createSession: () => { sessions++; return fakeSession() } })
    const room = await manager.create()

    await manager.retry(room.token)
    expect(sessions).toBe(0)

    await manager.close(room.token)
    expect(manager.get(room.token)).toBeUndefined()
    expect(existsSync(room.dir)).toBe(false)
  })

  // create(item) es create() + setMedia(): si el probe falla, no debe quedar una
  // sala fantasma en el mapa con media a null.
  it('create(item) no deja sala si la preparación falla', async () => {
    const manager = new RoomManager({ createSession: () => fakeSession() })
    const brokenDir = mkdtempSync(join(tmpdir(), 'rmbroken2-'))
    writeFileSync(join(brokenDir, 'roto.mkv'), 'esto no es un vídeo')
    const broken = (await scanLibrary([brokenDir]))[0]

    await expect(manager.create(broken)).rejects.toThrow()

    expect(manager.all()).toHaveLength(0)
  })
})
