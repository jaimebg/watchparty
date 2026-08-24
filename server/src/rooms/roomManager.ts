import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Readable } from 'node:stream'
import { cacheDir } from '../config.js'
import type { LibraryItem } from '../library/scanner.js'
import { probeFile, extractKeyframes, type MediaInfo } from '../media/probe.js'
import { planSegments, type Segment } from '../media/planner.js'
import { pickMode } from '../media/hlsLayout.js'
import { listSubtitleOptions, extractSubtitle, type SubtitleOption } from '../media/subtitles.js'
import { initialState, type PlaybackState } from './syncState.js'
import type { RoomMeta } from '../media/tmdb.js'
import { enrichAudioLangs } from '../media/lang.js'
import type { ChatEntry } from '../ws/messages.js'

export interface SessionLike {
  start(fromSegment?: number): void
  // requestSegment (la ruta cruda tal cual la escribió ffmpeg, sin reanclar) ya
  // no está aquí: solo openSegment forma parte del contrato que RoomManager
  // expone hacia fuera. Sigue existiendo como primitiva interna de
  // TranscodeSession (openSegment la llama para localizar el archivo antes de
  // reanclarlo), pero ningún llamador desde src/ la necesita ya directamente.
  openSegment(variant: number, index: number, timeoutMs?: number): Promise<Readable>
  requestInit(variant: number, timeoutMs?: number): Promise<string>
  seekTo(segmentIndex: number): void
  stop(): Promise<void>
  onError(cb: (log: string[]) => void): void
  lastLog: string[]
}

/**
 * Todo lo que depende del fichero que se está viendo. Vive aparte de `Room`
 * porque una sala puede existir sin película (el host la crea y reparte el
 * enlace antes de elegir) y porque puede cambiarla sin cerrar la sala.
 */
export interface RoomMedia {
  /** 1, 2, 3… Versiona las URLs de /stream y remonta el reproductor. */
  epoch: number
  item: LibraryItem
  info: MediaInfo
  segments: Segment[]
  subtitles: SubtitleOption[]
  meta: RoomMeta | null
  session: SessionLike
  /** <cacheDir>/<token>/e<epoch> */
  dir: string
  /**
   * Nombre de quien la puso, para el mensaje de sistema. Lo aporta el navegador
   * del host: el servidor no puede saber que la cookie de admin es el
   * participante «Jaime», son dos canales distintos. null = mensaje impersonal.
   */
  setBy: string | null
}

export interface Room {
  token: string
  /** <cacheDir>/<token>. Contiene un subdirectorio por epoch. */
  dir: string
  /** null = sala creada sin película: el host reparte el enlace antes de elegir. */
  media: RoomMedia | null
  state: PlaybackState
  chat: ChatEntry[]
  error: string[] | null
  /** Un cambio de película o un reintento en vuelo. Evita pisarse. */
  busy: boolean
  // TranscodeSession.onError only keeps a single callback (see transcoder.ts),
  // and RoomManager already needs that slot to record room.error. Rather than
  // fighting over the one callback, RoomManager registers its own single
  // onError handler and fans it out to whoever else wants to know (currently:
  // the ws hub, to broadcast {t:'error'} to every connected client).
  errorListeners: Set<(log: string[]) => void>
  // Notified once, synchronously, from close() before the room is torn down —
  // lets the ws hub close every live socket for the room (see hub.ts's
  // closeRoomSockets) instead of leaving zombie connections around.
  closeListeners: Set<() => void>
  /** Mismo patrón: el hub difunde el cambio de película a los clientes. */
  mediaListeners: Set<(media: RoomMedia) => void>
}

/**
 * Un cambio de película (o un reintento) ya está en marcha en esta sala. El
 * host es una sola persona: se rechaza el segundo en vez de encadenar cerrojos.
 */
export class RoomBusyError extends Error {
  constructor() { super('The room is already switching movies') }
}

/** El medio ya construido, antes de que exista su sesión de ffmpeg. */
interface PreparedMedia {
  epoch: number; item: LibraryItem; info: MediaInfo; segments: Segment[]
  subtitles: SubtitleOption[]; meta: RoomMeta | null; dir: string
  mode: 'copy' | 'transcode'
}

interface Deps {
  // El modo lo elige RoomManager, no quien construye la sesión: la rejilla de
  // segmentos que se planifica aquí solo es correcta para uno de los dos modos
  // (ver hlsLayout.ts), así que la decisión tiene que vivir en el mismo sitio
  // que la planificación.
  createSession: (item: LibraryItem, info: MediaInfo, segments: Segment[], roomDir: string, mode: 'copy' | 'transcode') => SessionLike
  // Metadatos externos (TMDB); ausente = sin metadatos. Nunca lanza (el lookup
  // captura sus propios errores y devuelve null).
  lookupMeta?: (cleanTitle: string) => Promise<RoomMeta | null>
}

export class RoomManager {
  private rooms = new Map<string, Room>()
  constructor(private deps: Deps) {}

  async create(item?: LibraryItem): Promise<Room> {
    const token = randomBytes(16).toString('base64url')
    const dir = join(cacheDir(), token)
    mkdirSync(dir, { recursive: true })
    const room: Room = {
      token, dir, media: null, state: initialState(Date.now()), chat: [], error: null, busy: false,
      errorListeners: new Set(), closeListeners: new Set(), mediaListeners: new Set(),
    }
    this.rooms.set(token, room)
    if (item) {
      // Una sala fantasma con media a null sería peor que ninguna: el host
      // creyó estar creando una sala CON película y el enlace no diría nada.
      try { await this.setMedia(token, item) } catch (e) { await this.close(token); throw e }
    }
    return room
  }

  get(token: string): Room | undefined { return this.rooms.get(token) }
  all(): Room[] { return [...this.rooms.values()] }

  /**
   * Todo el trabajo que puede fallar, antes de tocar la sala: si el fichero es
   * ilegible o ffprobe se atraganta, la película anterior sigue en marcha.
   */
  private async prepareMedia(item: LibraryItem, dir: string, epoch: number): Promise<PreparedMedia> {
    mkdirSync(dir, { recursive: true })
    const info = await probeFile(item.path)
    const mode = pickMode(info)
    // Solo copy corta donde diga la fuente; transcode fuerza su propia rejilla
    // de 4 s, así que ahí la lista de keyframes no solo sobra: planificar con
    // ella describiría cortes que ffmpeg no va a producir. De paso, esto ahorra
    // el volcado de paquetes de extractKeyframes (hasta 256 MB) en las salas
    // que van a transcodificar igualmente.
    const keyframes = mode === 'copy' ? await extractKeyframes(item.path) : null
    const segments = planSegments(info.durationSec, keyframes)
    const subtitles = listSubtitleOptions(info, item.srtFiles)
    for (const s of subtitles) {
      await extractSubtitle(item.path, info, item.srtFiles, s.id, join(dir, `sub_${s.id}.vtt`)).catch(() => {})
    }
    const meta = this.deps.lookupMeta ? await this.deps.lookupMeta(item.title) : null
    // Pistas de audio sin idioma declarado: se infiere del nombre del archivo o
    // del idioma original (TMDB) cuando solo hay una pista.
    info.audio = enrichAudioLangs(info.audio, basename(item.path), meta?.originalLang ?? null)
    return { epoch, item, info, segments, subtitles, meta, dir, mode }
  }

  async setMedia(token: string, item: LibraryItem, by: string | null = null): Promise<RoomMedia> {
    const room = this.rooms.get(token)
    if (!room) throw new Error(`Unknown room: ${token}`)
    if (room.busy) throw new RoomBusyError()
    room.busy = true

    const epoch = (room.media?.epoch ?? 0) + 1
    // Un subdirectorio por epoch, en vez de reutilizar el mismo: un cliente
    // puede estar descargando seg_0_00042.m4s de la película anterior justo
    // mientras el ffmpeg nuevo escribe un fichero con ese mismo nombre.
    const dir = join(room.dir, `e${epoch}`)
    let prepared: PreparedMedia
    try {
      prepared = await this.prepareMedia(item, dir, epoch)
    } catch (e) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* no llegó a existir */ }
      room.busy = false
      throw e
    }

    try {
      const previous = room.media
      // La sesión vieja se para ANTES de arrancar la nueva: así no hay dos
      // ffmpeg compitiendo por la CPU en el momento del cambio.
      await previous?.session.stop()
      const session = this.deps.createSession(prepared.item, prepared.info, prepared.segments, prepared.dir, prepared.mode)
      session.onError(log => { room.error = log; for (const cb of room.errorListeners) cb(log) })
      session.start()
      const media: RoomMedia = {
        epoch: prepared.epoch, item: prepared.item, info: prepared.info, segments: prepared.segments,
        subtitles: prepared.subtitles, meta: prepared.meta, session, dir: prepared.dir,
        setBy: by === null ? null : by.slice(0, 30),
      }
      room.media = media
      room.state = initialState(Date.now())
      room.error = null
      if (previous) {
        // Best-effort: en Windows un fichero con un descriptor abierto hace
        // fallar el borrado. Se queda huérfano y se lo lleva close().
        try { rmSync(previous.dir, { recursive: true, force: true }) } catch { /* se irá al cerrar */ }
      }
      for (const cb of room.mediaListeners) {
        // Un listener roto no invalida un cambio de película que YA ocurrió, ni debe
        // impedir que se enteren los demás.
        try { cb(media) } catch { /* nada que hacer aquí */ }
      }
      return media
    } finally {
      room.busy = false
    }
  }

  async retry(token: string): Promise<void> {
    const room = this.rooms.get(token)
    if (!room) return
    if (room.busy) throw new RoomBusyError()
    const media = room.media
    // Sin película no hay nada que reintentar. El endpoint ya lo rechaza con
    // 409 antes de llegar aquí; esto es la segunda barrera.
    if (!media) return
    // Mismo cerrojo que setMedia: sin él, un setMedia podría colarse mientras
    // el retry todavía está a mitad de montar su sesión nueva, y acabar los
    // dos con una sesión huérfana compitiendo por el mismo directorio.
    room.busy = true
    try {
      await media.session.stop()
      // El set entero de segmentos de la ejecución rota no debe sobrevivir al
      // reintento: un .m4s o init_*.mp4 viejo en disco puede hacer creer a
      // requestInit() de la sesión nueva que su propio init ya está completo
      // (ver transcoder.ts) y, si el reintento pasó de copy a transcode, ese
      // init viejo trae el SPS/PPS de la fuente mientras los segmentos nuevos
      // llevan los de libx264: un desajuste de decodificador permanente. Los
      // subtítulos extraídos (sub_*.vtt) siguen siendo válidos — un reintento no
      // los regenera — así que esos se conservan.
      for (const f of readdirSync(media.dir)) {
        if (f.endsWith('.stable.mp4') || f.endsWith('.m4s') || f.startsWith('init_')) {
          rmSync(join(media.dir, f), { force: true })
        }
      }
      room.error = null
      // El reintento siempre transcodifica, y transcode fuerza keyframes cada
      // 4 s: quedarse con la rejilla de keyframes de la fuente que planificó el
      // modo copy dejaría la playlist anunciando cortes que el ffmpeg nuevo no va
      // a producir. El cliente recarga tras el retry, así que recoge la lista nueva.
      media.segments = planSegments(media.info.durationSec, null)
      media.session = this.deps.createSession(media.item, media.info, media.segments, media.dir, 'transcode')
      media.session.onError(log => { room.error = log; for (const cb of room.errorListeners) cb(log) })
      media.session.start()
    } finally {
      room.busy = false
    }
  }

  async close(token: string): Promise<void> {
    const room = this.rooms.get(token)
    if (!room) return
    await room.media?.session.stop()
    for (const cb of room.closeListeners) cb()
    // El directorio de la sala entero, con todos sus subdirectorios de epoch.
    rmSync(room.dir, { recursive: true, force: true })
    this.rooms.delete(token)
  }
}
