import type { ClientMsg, ServerMsg } from './types'

export const nextDelay = (attempt: number) => Math.min(500 * 2 ** attempt, 8000)

export function connectRoom(token: string, name: string, onMsg: (m: ServerMsg) => void) {
  let ws: WebSocket | null = null
  let closed = false
  let attempt = 0

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws/${token}`)
    ws.onopen = () => { attempt = 0; ws!.send(JSON.stringify({ t: 'join', name })) }
    ws.onmessage = e => onMsg(JSON.parse(e.data))
    ws.onclose = () => { if (!closed) setTimeout(open, nextDelay(attempt++)) }
  }
  open()

  return {
    send: (m: ClientMsg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) },
    close: () => { closed = true; ws?.close() },
  }
}
