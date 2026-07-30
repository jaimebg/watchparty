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
  media: RoomMedia
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
    const dir = join(cacheDir(), token)
    const epoch = 1
    const mediaDir = join(dir, `e${epoch}`)
    mkdirSync(mediaDir, { recursive: true })
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
      await extractSubtitle(item.path, info, item.srtFiles, s.id, join(mediaDir, `sub_${s.id}.vtt`)).catch(() => {})
    }
    const meta = this.deps.lookupMeta ? await this.deps.lookupMeta(item.title) : null
    // Pistas de audio sin idioma declarado: se infiere del nombre del archivo o
    // del idioma original (TMDB) cuando solo hay una pista.
    info.audio = enrichAudioLangs(info.audio, basename(item.path), meta?.originalLang ?? null)
    const session = this.deps.createSession(item, info, segments, mediaDir, mode)
    const room: Room = {
      token, dir,
      media: { epoch, item, info, segments, subtitles, meta, session, dir: mediaDir, setBy: null },
      state: initialState(Date.now()), chat: [], error: null, busy: false,
      errorListeners: new Set(), closeListeners: new Set(), mediaListeners: new Set(),
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
    const media = room.media
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
  }

  async close(token: string): Promise<void> {
    const room = this.rooms.get(token)
    if (!room) return
    await room.media.session.stop()
    for (const cb of room.closeListeners) cb()
    // El directorio de la sala entero, con todos sus subdirectorios de epoch.
    rmSync(room.dir, { recursive: true, force: true })
    this.rooms.delete(token)
  }
}
