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
  // requestSegment (the raw path exactly as ffmpeg wrote it, un-re-anchored) is
  // no longer here: only openSegment is part of the contract RoomManager exposes
  // outward. It still exists as an internal TranscodeSession primitive
  // (openSegment calls it to locate the file before re-anchoring it), but no
  // caller in src/ needs it directly any more.
  openSegment(variant: number, index: number, timeoutMs?: number): Promise<Readable>
  requestInit(variant: number, timeoutMs?: number): Promise<string>
  seekTo(segmentIndex: number): void
  stop(): Promise<void>
  onError(cb: (log: string[]) => void): void
  lastLog: string[]
}

/**
 * Everything that depends on the file being watched. It lives apart from `Room`
 * because a room can exist without a movie (the host creates it and hands out
 * the link before choosing) and because it can change movie without closing.
 */
export interface RoomMedia {
  /** 1, 2, 3… Versions the /stream URLs and remounts the player. */
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
   * Name of whoever put it on, for the system message. The host's browser
   * supplies it: the server has no way to know that the admin cookie is the
   * participant named "Alex" — they are two separate channels. null means an
   * impersonal message.
   */
  setBy: string | null
}

export interface Room {
  token: string
  /** <cacheDir>/<token>. Holds one subdirectory per epoch. */
  dir: string
  /** null = room created without a movie: the host hands out the link before choosing. */
  media: RoomMedia | null
  state: PlaybackState
  chat: ChatEntry[]
  error: string[] | null
  /** A movie change or a retry in flight. Keeps them from stepping on each other. */
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
  /** Same pattern: the hub broadcasts the movie change to the clients. */
  mediaListeners: Set<(media: RoomMedia) => void>
}

/**
 * A movie change (or a retry) is already under way in this room. The host is one
 * person: the second one is rejected rather than chaining locks.
 */
export class RoomBusyError extends Error {
  constructor() { super('The room is already switching movies') }
}

/** The media, fully built, before its ffmpeg session exists. */
interface PreparedMedia {
  epoch: number; item: LibraryItem; info: MediaInfo; segments: Segment[]
  subtitles: SubtitleOption[]; meta: RoomMeta | null; dir: string
  mode: 'copy' | 'transcode'
}

interface Deps {
  // RoomManager picks the mode, not whoever builds the session: the segment grid
  // planned here is only correct for one of the two modes (see hlsLayout.ts), so
  // the decision has to live in the same place as the planning.
  createSession: (item: LibraryItem, info: MediaInfo, segments: Segment[], roomDir: string, mode: 'copy' | 'transcode') => SessionLike
  // External metadata (TMDB); absent means no metadata. Never throws (the lookup
  // catches its own errors and returns null).
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
      // A phantom room with media set to null would be worse than none: the
      // host thought they were creating a room WITH a movie, and the link would
      // say nothing about it.
      try { await this.setMedia(token, item) } catch (e) { await this.close(token); throw e }
    }
    return room
  }

  get(token: string): Room | undefined { return this.rooms.get(token) }
  all(): Room[] { return [...this.rooms.values()] }

  /**
   * All the work that can fail, before touching the room: if the file is
   * unreadable or ffprobe chokes, the previous movie keeps playing.
   */
  private async prepareMedia(item: LibraryItem, dir: string, epoch: number): Promise<PreparedMedia> {
    mkdirSync(dir, { recursive: true })
    const info = await probeFile(item.path)
    const mode = pickMode(info)
    // Only copy mode cuts where the source says; transcode forces its own 4 s
    // grid, so there the keyframe list is not merely redundant: planning with it
    // would describe cuts ffmpeg is not going to produce. As a bonus, this saves
    // extractKeyframes's packet dump (up to 256 MB) in rooms that are going to
    // transcode anyway.
    const keyframes = mode === 'copy' ? await extractKeyframes(item.path) : null
    const segments = planSegments(info.durationSec, keyframes)
    const subtitles = listSubtitleOptions(info, item.srtFiles)
    for (const s of subtitles) {
      await extractSubtitle(item.path, info, item.srtFiles, s.id, join(dir, `sub_${s.id}.vtt`)).catch(() => {})
    }
    const meta = this.deps.lookupMeta ? await this.deps.lookupMeta(item.title) : null
    // Audio tracks with no declared language: inferred from the file name, or
    // from the original language (TMDB) when there is only one track.
    info.audio = enrichAudioLangs(info.audio, basename(item.path), meta?.originalLang ?? null)
    return { epoch, item, info, segments, subtitles, meta, dir, mode }
  }

  async setMedia(token: string, item: LibraryItem, by: string | null = null): Promise<RoomMedia> {
    const room = this.rooms.get(token)
    if (!room) throw new Error(`Unknown room: ${token}`)
    if (room.busy) throw new RoomBusyError()
    room.busy = true

    const epoch = (room.media?.epoch ?? 0) + 1
    // One subdirectory per epoch, rather than reusing the same one: a client may
    // be downloading the previous movie's seg_0_00042.m4s at the very moment the
    // new ffmpeg writes a file by that same name.
    const dir = join(room.dir, `e${epoch}`)
    let prepared: PreparedMedia
    try {
      prepared = await this.prepareMedia(item, dir, epoch)
    } catch (e) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* never came into existence */ }
      room.busy = false
      throw e
    }

    try {
      const previous = room.media
      // The old session is stopped BEFORE the new one starts: that way there
      // are never two ffmpegs fighting over the CPU during the switch.
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
        // Best-effort: on Windows a file with an open descriptor makes the
        // delete fail. It is left orphaned and close() takes it away.
        try { rmSync(previous.dir, { recursive: true, force: true }) } catch { /* it will go on close */ }
      }
      for (const cb of room.mediaListeners) {
        // A broken listener does not undo a movie change that ALREADY happened,
        // and must not stop the others from finding out.
        try { cb(media) } catch { /* nothing to do here */ }
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
    // With no movie there is nothing to retry. The endpoint already rejects it
    // with a 409 before we get here; this is the second barrier.
    if (!media) return
    // Same lock as setMedia: without it, a setMedia could slip in while the
    // retry is still halfway through standing its new session up, leaving both
    // with an orphaned session fighting over the same directory.
    room.busy = true
    try {
      await media.session.stop()
      // The broken run's whole segment set must not survive the retry: an old
      // .m4s or init_*.mp4 on disk can convince the new session's requestInit()
      // that its own init is already complete (see transcoder.ts) and, if the
      // retry moved from copy to transcode, that old init carries the source's
      // SPS/PPS while the new segments carry libx264's: a permanent decoder
      // mismatch. The extracted subtitles (sub_*.vtt) are still valid — a retry
      // does not regenerate them — so those are kept.
      for (const f of readdirSync(media.dir)) {
        if (f.endsWith('.stable.mp4') || f.endsWith('.m4s') || f.startsWith('init_')) {
          rmSync(join(media.dir, f), { force: true })
        }
      }
      room.error = null
      // A retry always transcodes, and transcode forces keyframes every 4 s:
      // keeping the source keyframe grid that copy mode planned with would leave
      // the playlist announcing cuts the new ffmpeg is not going to produce. The
      // client reloads after a retry, so it picks up the new list.
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
    // The room's whole directory, every epoch subdirectory included.
    rmSync(room.dir, { recursive: true, force: true })
    this.rooms.delete(token)
  }
}
