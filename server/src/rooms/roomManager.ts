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
  requestSegment(variant: number, index: number, timeoutMs?: number): Promise<string>
  // Los bytes listos para servir: requestSegment da la ruta del archivo tal cual
  // lo escribió ffmpeg, y openSegment lo ancla en el tiempo de la playlist.
  openSegment(variant: number, index: number, timeoutMs?: number): Promise<Readable>
  requestInit(variant: number, timeoutMs?: number): Promise<string>
  seekTo(segmentIndex: number): void
  stop(): Promise<void>
  onError(cb: (log: string[]) => void): void
  lastLog: string[]
}

export interface Room {
  token: string; item: LibraryItem; info: MediaInfo; segments: Segment[]
  subtitles: SubtitleOption[]; session: SessionLike; state: PlaybackState
  chat: ChatEntry[]; error: string[] | null; roomDir: string
  meta: RoomMeta | null
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

  async create(item: LibraryItem): Promise<Room> {
    const token = randomBytes(16).toString('base64url')
    const roomDir = join(cacheDir(), token)
    mkdirSync(roomDir, { recursive: true })
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
      await extractSubtitle(item.path, info, item.srtFiles, s.id, join(roomDir, `sub_${s.id}.vtt`)).catch(() => {})
    }
    const meta = this.deps.lookupMeta ? await this.deps.lookupMeta(item.title) : null
    // Pistas de audio sin idioma declarado: se infiere del nombre del archivo o
    // del idioma original (TMDB) cuando solo hay una pista.
    info.audio = enrichAudioLangs(info.audio, basename(item.path), meta?.originalLang ?? null)
    const session = this.deps.createSession(item, info, segments, roomDir, mode)
    const room: Room = {
      token, item, info, segments, subtitles, session, state: initialState(Date.now()), chat: [], error: null, roomDir,
      meta, errorListeners: new Set(), closeListeners: new Set(),
    }
    session.onError(log => { room.error = log; for (const cb of room.errorListeners) cb(log) })
    session.start()
    this.rooms.set(token, room)
    return room
  }

  get(token: string): Room | undefined { return this.rooms.get(token) }
  all(): Room[] { return [...this.rooms.values()] }

  async retry(token: string): Promise<void> {
    const room = this.rooms.get(token)
    if (!room) return
    await room.session.stop()
    // El set entero de segmentos de la ejecución rota no debe sobrevivir al
    // reintento: un .m4s o init_*.mp4 viejo en disco puede hacer creer a
    // requestInit() de la sesión nueva que su propio init ya está completo
    // (ver transcoder.ts) y, si el reintento pasó de copy a transcode, ese
    // init viejo trae el SPS/PPS de la fuente mientras los segmentos nuevos
    // llevan los de libx264: un desajuste de decodificador permanente. Los
    // subtítulos extraídos (sub_*.vtt) siguen siendo válidos — un reintento no
    // los regenera — así que esos se conservan.
    for (const f of readdirSync(room.roomDir)) {
      if (f.endsWith('.stable.mp4') || f.endsWith('.m4s') || f.startsWith('init_')) {
        rmSync(join(room.roomDir, f), { force: true })
      }
    }
    room.error = null
    // El reintento siempre transcodifica, y transcode fuerza keyframes cada
    // 4 s: quedarse con la rejilla de keyframes de la fuente que planificó el
    // modo copy dejaría la playlist anunciando cortes que el ffmpeg nuevo no va
    // a producir. El cliente recarga tras el retry, así que recoge la lista nueva.
    room.segments = planSegments(room.info.durationSec, null)
    room.session = this.deps.createSession(room.item, room.info, room.segments, room.roomDir, 'transcode')
    room.session.onError(log => { room.error = log; for (const cb of room.errorListeners) cb(log) })
    room.session.start()
  }

  async close(token: string): Promise<void> {
    const room = this.rooms.get(token)
    if (!room) return
    await room.session.stop()
    for (const cb of room.closeListeners) cb()
    rmSync(room.roomDir, { recursive: true, force: true })
    this.rooms.delete(token)
  }
}
