// `npm run tunnel:up` / `npm run tunnel:down`. El control manual del túnel del
// relevo, para cuando no se quiere pasar por `npm start`.

import { bringDown, bringUp } from './tunnel.js'

const down = process.argv[2] === 'down'
const r = down ? bringDown() : bringUp()
console.log(`${r.ok ? '✅' : '⚠️ '} ${r.message}`)
process.exit(r.ok ? 0 : 1)
