import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { cacheDir } from '../config.js'
import type { LibraryItem } from '../library/scanner.js'
import { probeFile, extractKeyframes, type MediaInfo } from '../media/probe.js'
import { planSegments, type Segment } from '../media/planner.js'
import { listSubtitleOptions, extractSubtitle, type SubtitleOption } from '../media/subtitles.js'
import { initialState, type PlaybackState } from './syncState.js'

export interface SessionLike {
  start(fromSegment?: number): void
  requestSegment(variant: number, index: number, timeoutMs?: number): Promise<string>
  seekTo(segmentIndex: number): void
  stop(): Promise<void>
  onError(cb: (log: string[]) => void): void
  lastLog: string[]
}

export interface Room {
  token: string; item: LibraryItem; info: MediaInfo; segments: Segment[]
  subtitles: SubtitleOption[]; session: SessionLike; state: PlaybackState
  chat: unknown[]; error: string[] | null; roomDir: string
}

interface Deps { createSession: (item: LibraryItem, info: MediaInfo, segments: Segment[], roomDir: string, forceTranscode?: boolean) => SessionLike }

export class RoomManager {
  private rooms = new Map<string, Room>()
  constructor(private deps: Deps) {}

  async create(item: LibraryItem): Promise<Room> {
    const token = randomBytes(16).toString('base64url')
    const roomDir = join(cacheDir(), token)
    mkdirSync(roomDir, { recursive: true })
    const info = await probeFile(item.path)
    const keyframes = info.videoCodec === 'h264' ? await extractKeyframes(item.path) : null
    const segments = planSegments(info.durationSec, keyframes)
    const subtitles = listSubtitleOptions(info, item.srtFiles)
    for (const s of subtitles) {
      await extractSubtitle(item.path, info, item.srtFiles, s.id, join(roomDir, `sub_${s.id}.vtt`)).catch(() => {})
    }
    const session = this.deps.createSession(item, info, segments, roomDir)
    const room: Room = { token, item, info, segments, subtitles, session, state: initialState(Date.now()), chat: [], error: null, roomDir }
    session.onError(log => { room.error = log })
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
    room.error = null
    room.session = this.deps.createSession(room.item, room.info, room.segments, room.roomDir, true)
    room.session.onError(log => { room.error = log })
    room.session.start()
  }

  async close(token: string): Promise<void> {
    const room = this.rooms.get(token)
    if (!room) return
    await room.session.stop()
    rmSync(room.roomDir, { recursive: true, force: true })
    this.rooms.delete(token)
  }
}
