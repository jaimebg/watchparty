// `npm run tunnel:up` / `npm run tunnel:down`. Manual control of the relay
// tunnel, for when you do not want to go through `npm start`.

import { bringDown, bringUp } from './tunnel.js'

const down = process.argv[2] === 'down'
const r = down ? bringDown() : bringUp()
console.log(`${r.ok ? '✅' : '⚠️ '} ${r.message}`)
process.exit(r.ok ? 0 : 1)
