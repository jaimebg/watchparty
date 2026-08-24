// Comprobación de entorno que corre en cada `npm start`: recolecta hechos,
// arregla solo lo que se puede arreglar solo (levantar el túnel del relevo) y
// avisa del resto con la acción concreta al lado. Solo aborta si algo hace que
// arrancar no tenga sentido.
//
// El criterio de qué es fatal y qué es aviso vive en checks.ts, sin efectos, para
// poder probarlo entero. Aquí solo está la recolección y la impresión.

import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { loadConfig } from '../config.js'
import { evaluate, formatFinding, worstLevel, type Facts } from './checks.js'
import { bringUp, tunnelState, peerReachable } from './tunnel.js'

function runnable(path: string | null | undefined): boolean {
  if (!path || !existsSync(path)) return false
  try {
    // En Windows el bit de ejecución no aplica; basta con que el fichero esté.
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Intenta ocupar el puerto: la única forma fiable de saber si está libre. */
function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen({ port, host: '0.0.0.0' })
  })
}

const config = loadConfig()
const webDist = fileURLToPath(new URL('../../../web/dist/index.html', import.meta.url))

// El relevo se levanta ANTES de evaluar, para que el informe describa el estado
// final y no uno que ya hemos corregido. Solo si hay streamBaseUrl: sin él el
// vídeo sale por el mismo origen y no hay nada que levantar.
if (config.streamBaseUrl && tunnelState() === 'down') {
  const r = bringUp()
  if (!r.ok) console.log(`⚠️  ${r.message}`)
}

const facts: Facts = {
  platform: process.platform,
  nodeMajor: Number(process.versions.node.split('.')[0]),
  ffmpegOk: runnable(ffmpegPath as unknown as string),
  ffprobeOk: runnable(ffprobeStatic.path),
  webBuilt: existsSync(webDist),
  mediaFolders: config.mediaFolders,
  mediaFoldersPresent: config.mediaFolders.filter(isDir),
  port: config.port,
  portFree: await portFree(config.port),
  streamBaseUrl: config.streamBaseUrl ?? null,
  tunnel: tunnelState(),
  tunnelPeerReachable: false,
  tunnelToken: config.tunnelToken ?? null,
  tunnelUrl: config.tunnelUrl ?? null,
}
// El ping cuesta hasta 2 s, así que solo se paga si hay interfaz que probar.
if (facts.tunnel === 'up') facts.tunnelPeerReachable = peerReachable()

const findings = evaluate(facts)
const level = worstLevel(findings)

console.log('\n🎬 Watchparty environment check\n')
// Con todo en verde el detalle no aporta: solo se listan los problemas, y un
// resumen de una línea para lo que está bien.
const problems = findings.filter(f => f.level !== 'ok')
if (problems.length === 0) {
  console.log(findings.map(f => formatFinding(f)).join('\n'))
} else {
  const okCount = findings.length - problems.length
  if (okCount > 0) console.log(`✅ ${okCount} check${okCount === 1 ? '' : 's'} passed\n`)
  console.log(problems.map(f => formatFinding(f)).join('\n'))
}

if (level === 'fatal') {
  console.log('\n❌ Can\'t start until the issues above are resolved.\n')
  process.exit(1)
}
console.log(level === 'warn' ? '\n▶️  Starting with warnings…\n' : '\n▶️  All set.\n')
