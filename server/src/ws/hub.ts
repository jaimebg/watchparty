import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { AppDeps } from '../app.js'
import type { Room } from '../rooms/roomManager.js'
import { apply } from '../rooms/syncState.js'
import * as stall from '../rooms/stallControl.js'
import { segmentForTime } from '../media/planner.js'
import type { ChatEntry, ClientMsg, Participant, ServerMsg } from './messages.js'

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c']
const conns = new Map<Room, Map<WebSocket, Participant>>()

export function formatTime(sec: number): string {
  const clamped = Math.max(0, sec)
  const h = Math.floor(clamped / 3600), m = Math.floor((clamped % 3600) / 60), s = Math.floor(clamped % 60)
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

function send(ws: WebSocket, m: ServerMsg): void { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }

function broadcast(room: Room, m: ServerMsg): void {
  const peers = conns.get(room)
  if (!peers) return
  for (const ws of peers.keys()) send(ws, m)
}

function system(room: Room, text: string): void {
  const entry: ChatEntry = { id: randomBytes(6).toString('hex'), from: { id: 'sys', name: 'sistema', color: '#888', active: true }, kind: 'system', text, at: Date.now() }
  room.chat.push(entry)
  room.chat = room.chat.slice(-500)
  broadcast(room, { t: 'chat', entry })
}

// Closes every live socket for a room (called from RoomManager.close()'s
// closeListeners, once the ffmpeg session has already stopped) and prunes
// the room's entry from `conns` so nothing keeps a dead room's peer map
// alive. Without this, sockets connected to a closed room stay open: chat
// keeps "working" in a dead room, and a seek would respawn ffmpeg pointed at
// a roomDir that no longer exists.
export function closeRoomSockets(room: Room): void {
  const peers = conns.get(room)
  if (!peers) return
  for (const ws of peers.keys()) {
    try { ws.close(4001, 'room closed') } catch { /* already closing */ }
  }
  stall.detach(room)
  conns.delete(room)
}

export function registerHub(app: FastifyInstance, deps: AppDeps): void {
  app.get('/ws/:token', { websocket: true }, (socket: WebSocket, req) => {
    const room = deps.rooms.get((req.params as any).token)
    if (!room) { socket.close(4004, 'room not found'); return }
    if (!conns.has(room)) {
      conns.set(room, new Map())
      // One-time-per-room hookups: fan out ffmpeg errors from RoomManager to
      // every client currently (and later) connected to this room, and close
      // every socket once the room itself is torn down.
      room.errorListeners.add(log => broadcast(room, { t: 'error', log }))
      room.closeListeners.add(() => closeRoomSockets(room))
      stall.attach(room, () => broadcast(room, { t: 'state', state: room.state, serverNow: Date.now() }))
    }
    const peers = conns.get(room)!
    let me: Participant | null = null
    let bufferingActive = false

    socket.on('message', (raw: Buffer) => {
      let msg: ClientMsg
      try { msg = JSON.parse(raw.toString()) } catch { return }

      // Defensive: the payload above is attacker-controlled and only shape-checked
      // field-by-field below, not schema-validated. This try/catch is a second
      // belt so that no malformed message or unforeseen edge case can throw out of
      // this listener and take down the whole process for every room.
      try {
        const now = Date.now()

        if (msg.t === 'join') {
          if (typeof msg.name !== 'string') return
          me = { id: randomBytes(6).toString('hex'), name: msg.name.slice(0, 30) || 'Anónimo', color: COLORS[peers.size % COLORS.length], active: true }
          peers.set(socket, me)
          send(socket, { t: 'welcome', self: me, participants: [...peers.values()], state: room.state, serverNow: now, history: room.chat })
          broadcast(room, { t: 'presence', participants: [...peers.values()] })
          system(room, `${me.name} se unió`)
          return
        }
        if (!me) return

        switch (msg.t) {
          case 'play': case 'pause': {
            room.state = apply(room.state, { type: msg.t, at: now })
            broadcast(room, { t: 'state', state: room.state, serverNow: now })
            system(room, msg.t === 'play' ? `${me.name} reanudó` : `${me.name} pausó`)
            if (msg.t === 'play') stall.refresh(room, now)
            break
          }
          case 'seek': {
            if (typeof msg.position !== 'number' || !Number.isFinite(msg.position)) return
            const position = Math.min(Math.max(msg.position, 0), room.info.durationSec)
            room.state = apply(room.state, { type: 'seek', position, at: now })
            room.session.seekTo(segmentForTime(room.segments, position))
            broadcast(room, { t: 'state', state: room.state, serverNow: now })
            system(room, `${me.name} saltó a ${formatTime(position)}`)
            stall.refresh(room, now)
            break
          }
          case 'chat': {
            if (typeof msg.text !== 'string') return
            const entry: ChatEntry = { id: randomBytes(6).toString('hex'), from: me, at: now, kind: 'text', text: msg.text.slice(0, 1000) }
            room.chat.push(entry)
            room.chat = room.chat.slice(-500)
            broadcast(room, { t: 'chat', entry })
            break
          }
          case 'gif': {
            if (typeof msg.url !== 'string') return
            const entry: ChatEntry = { id: randomBytes(6).toString('hex'), from: me, at: now, kind: 'gif', text: '', gifUrl: msg.url }
            room.chat.push(entry)
            room.chat = room.chat.slice(-500)
            broadcast(room, { t: 'chat', entry })
            break
          }
          case 'reaction': {
            if (typeof msg.emoji !== 'string') return
            broadcast(room, { t: 'reaction', emoji: msg.emoji.slice(0, 8), from: me.name })
            break
          }
          case 'buffering': {
            if (typeof msg.value !== 'boolean') return
            bufferingActive = msg.value
            broadcast(room, { t: 'buffering', name: me.name, value: msg.value })
            stall.setBuffering(room, socket, msg.value, now)
            break
          }
          case 'visibility': {
            if (typeof msg.active !== 'boolean') return
            me.active = msg.active
            broadcast(room, { t: 'presence', participants: [...peers.values()] })
            break
          }
        }
      } catch {
        // swallow: a malformed or unexpected message must never crash the hub
      }
    })

    socket.on('close', () => {
      if (!me) return
      peers.delete(socket)
      // A participant who disconnects mid-buffer must not leave a stale
      // "X está cargando…" indicator behind for everyone else.
      if (bufferingActive) broadcast(room, { t: 'buffering', name: me.name, value: false })
      stall.forget(room, socket, Date.now())
      broadcast(room, { t: 'presence', participants: [...peers.values()] })
      system(room, `${me.name} salió`)
    })
  })
}
