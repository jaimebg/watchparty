// Regenerates web/src/chat/emojiCatalog.ts from emojibase-data, English + Spanish.
//
//   node web/scripts/gen-emoji-catalog.mjs
//
// Run BY HAND, only when Unicode ships new emojis. It stays out of
// `npm run build` and `npm test` on purpose: nobody should need network access
// to build the project or to run the tests.
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A pinned version, not `latest`: a regeneration must not change its result on
// its own between one run and the next.
const VERSION = '16'
const source = locale => `https://cdn.jsdelivr.net/npm/emojibase-data@${VERSION}/${locale}/compact.json`
// Skin-tone and hair modifiers. Not emotes.
const COMPONENT_GROUP = 2

async function fetchLocale(locale) {
  const res = await fetch(source(locale))
  if (!res.ok) throw new Error(`${source(locale)} responded ${res.status}`)
  return res.json()
}

const [english, spanish] = await Promise.all([fetchLocale('en'), fetchLocale('es')])
const spanishByUnicode = new Map(spanish.map(e => [e.unicode, e]))

// One row per emoji, bilingual: [unicode, labelEn, labelEs, keywords, group].
// Keywords carry the tags of both languages so a Spanish viewer can search
// "risa" and an English one "laugh" against the same catalog.
// The label falls back to the English one for the rare emoji missing from the
// Spanish dataset.
const rows = english
  .filter(e => e.group !== undefined && e.group !== COMPONENT_GROUP)
  .sort((a, b) => a.order - b.order)
  .map(e => {
    const alt = spanishByUnicode.get(e.unicode)
    const keywords = [...new Set([...(e.tags ?? []), ...(alt?.tags ?? [])])]
    return [e.unicode, e.label, alt?.label ?? e.label, keywords.join(' '), e.group]
  })

const out = `// GENERATED — do not edit by hand. Regenerate with:
//   node web/scripts/gen-emoji-catalog.mjs
// Source: ${source('en')} + ${source('es')}
import type { EmojiRow } from './emojiSearch'

export const EMOJI_CATALOG: EmojiRow[] = ${JSON.stringify(rows)}
`

const here = dirname(fileURLToPath(import.meta.url))
await writeFile(join(here, '../src/chat/emojiCatalog.ts'), out)
console.log(`${rows.length} emojis written`)
