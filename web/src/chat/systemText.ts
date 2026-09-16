import { lang as detectedLang, translate, type Lang } from '../i18n'
import { formatClock } from '../player/format'
import type { SystemEvent } from '../types'

// System chat entries are stored as events, not text: the server broadcasts one
// entry to the whole room and each viewer reads it in their own language.
export function formatSystemEvent(event: SystemEvent, lang: Lang = detectedLang): string {
  switch (event.type) {
    case 'join': return translate(lang, 'chat.joined', { name: event.name })
    case 'left': return translate(lang, 'chat.left', { name: event.name })
    case 'resumed': return translate(lang, 'chat.resumed', { name: event.name })
    case 'paused': return translate(lang, 'chat.paused', { name: event.name })
    case 'seek': return translate(lang, 'chat.seek', { name: event.name, time: formatClock(event.position) })
    case 'nowPlaying':
      return event.setBy
        ? translate(lang, 'chat.setBy', { name: event.setBy, title: event.title })
        : translate(lang, 'chat.nowPlaying', { title: event.title })
  }
}
