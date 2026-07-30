import { useState } from 'react'
import { EmojiPicker } from './EmojiPicker'
import { addQuick, parseQuick, QUICK_KEY, removeQuick } from './quickEmojis'
import type { ClientMsg } from '../types'

export function ReactionsBar({ send }: { send: (m: ClientMsg) => void }) {
  // La lista vive aquí porque esta barra es su único consumidor. Persistencia
  // por navegador: no hay cuentas y las salas son efímeras.
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
      <button type="button" className="btn-add-emoji" aria-label="Elegir emojis" title="Elegir emojis"
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
