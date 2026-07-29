import type { ClientMsg } from '../types'

const EMOJIS = ['😂', '❤️', '😱', '🤯', '🍿', '🔥', '👏', '😭', '💀', '🙈']

export function ReactionsBar({ send }: { send: (m: ClientMsg) => void }) {
  return (
    <div className="reactions-bar">
      {EMOJIS.map(emoji => (
        <button key={emoji} type="button" onClick={() => send({ t: 'reaction', emoji })}>
          {emoji}
        </button>
      ))}
    </div>
  )
}
