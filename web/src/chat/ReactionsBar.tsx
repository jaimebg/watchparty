import { useState } from 'react'
import { EmojiPicker } from './EmojiPicker'
import { addQuick, parseQuick, QUICK_KEY, removeQuick } from './quickEmojis'
import type { ClientMsg } from '../types'

export function ReactionsBar({ send }: { send: (m: ClientMsg) => void }) {
  // The list lives here because this bar is its only consumer. Persistence is
  // per browser: there are no accounts and rooms are ephemeral.
  const [quick, setQuick] = useState(() => parseQuick(localStorage.getItem(QUICK_KEY)))
  const [pickerOpen, setPickerOpen] = useState(false)

  const update = (next: string[]) => {
    setQuick(next)
    localStorage.setItem(QUICK_KEY, JSON.stringify(next))
  }

  return (
    <div className="reactions-bar">
      {quick.map(emoji => (
        <button key={emoji} type="button" onClick={() => send({ t: 'reaction', emoji })}>
          {emoji}
        </button>
      ))}
      <button type="button" className="btn-add-emoji" aria-label="Pick emojis" title="Pick emojis"
        onClick={() => setPickerOpen(true)}>+</button>

      {pickerOpen && (
        <EmojiPicker
          quick={quick}
          onAdd={e => update(addQuick(quick, e))}
          onRemove={e => update(removeQuick(quick, e))}
          onClose={() => setPickerOpen(false)} />
      )}
    </div>
  )
}
