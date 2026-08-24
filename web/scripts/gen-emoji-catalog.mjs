// Regenerates web/src/chat/emojiCatalog.ts from emojibase-data (English).
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
const SOURCE = 'https://cdn.jsdelivr.net/npm/emojibase-data@16/en/compact.json'
// Skin-tone and hair modifiers. Not emotes.
const COMPONENT_GROUP = 2

const res = await fetch(SOURCE)
if (!res.ok) throw new Error(`${SOURCE} responded ${res.status}`)
const data = await res.json()

const rows = data
  .filter(e => e.group !== undefined && e.group !== COMPONENT_GROUP)
  .sort((a, b) => a.order - b.order)
  .map(e => [e.unicode, e.label, (e.tags ?? []).join(' '), e.group])

const out = `// GENERATED — do not edit by hand. Regenerate with:
//   node web/scripts/gen-emoji-catalog.mjs
// Source: ${SOURCE}
import type { EmojiRow } from './emojiSearch'

export const EMOJI_CATALOG: EmojiRow[] = ${JSON.stringify(rows)}
`

const here = dirname(fileURLToPath(import.meta.url))
await writeFile(join(here, '../src/chat/emojiCatalog.ts'), out)
console.log(`${rows.length} emojis written`)
