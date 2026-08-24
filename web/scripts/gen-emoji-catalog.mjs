// Regenera web/src/chat/emojiCatalog.ts desde emojibase-data (inglés).
//
//   node web/scripts/gen-emoji-catalog.mjs
//
// Se ejecuta A MANO, solo cuando Unicode saque emojis nuevos. Queda fuera de
// `npm run build` y de `npm test` a propósito: nadie debería necesitar red para
// compilar el proyecto ni para pasar los tests.
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Versión fijada, no `latest`: una regeneración no debe cambiar el resultado
// por su cuenta entre una ejecución y la siguiente.
const SOURCE = 'https://cdn.jsdelivr.net/npm/emojibase-data@16/en/compact.json'
// Modificadores de tono de piel y de pelo. No son emotes.
const COMPONENT_GROUP = 2

const res = await fetch(SOURCE)
if (!res.ok) throw new Error(`${SOURCE} respondió ${res.status}`)
const data = await res.json()

const rows = data
  .filter(e => e.group !== undefined && e.group !== COMPONENT_GROUP)
  .sort((a, b) => a.order - b.order)
  .map(e => [e.unicode, e.label, (e.tags ?? []).join(' '), e.group])

const out = `// GENERATED — do not edit by hand. Regenerate with:
//   node web/scripts/gen-emoji-catalog.mjs
// Fuente: ${SOURCE}
import type { EmojiRow } from './emojiSearch'

export const EMOJI_CATALOG: EmojiRow[] = ${JSON.stringify(rows)}
`

const here = dirname(fileURLToPath(import.meta.url))
await writeFile(join(here, '../src/chat/emojiCatalog.ts'), out)
console.log(`${rows.length} emojis written`)
