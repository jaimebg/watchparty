import type { ClientMsg, ServerMsg } from './types'

export const nextDelay = (attempt: number) => Math.min(500 * 2 ** attempt, 8000)

export function connectRoom(token: string, name: string, onMsg: (m: ServerMsg) => void) {
  let ws: WebSocket | null = null
  let closed = false
  let attempt = 0

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws/${token}`)
    ws.onopen = () => {
      attempt = 0
      ws!.send(JSON.stringify({ t: 'join', name }))
      // The server creates us with active:true; if the tab was already hidden on
      // (re)connect, we correct that immediately. When it is visible there is
      // nothing to correct (and a redundant presence broadcast per join is
      // avoided).
      if (document.visibilityState === 'hidden') ws!.send(JSON.stringify({ t: 'visibility', active: false }))
    }
    ws.onmessage = e => onMsg(JSON.parse(e.data))
    ws.onclose = () => { if (!closed) setTimeout(open, nextDelay(attempt++)) }
  }
  open()

  return {
    send: (m: ClientMsg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) },
    close: () => { closed = true; ws?.close() },
  }
}
