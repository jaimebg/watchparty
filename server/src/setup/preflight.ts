// The environment check that runs on every `npm start`: it gathers facts, fixes
// only what can fix itself (bringing the relay tunnel up) and warns about the
// rest with the concrete action alongside. It aborts only when something makes
// starting pointless.
//
// The judgement about what is fatal and what is a warning lives in checks.ts,
// effect-free, so it can be tested end to end. Only the gathering and the
// printing are here.

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
    // On Windows the execute bit does not apply; the file being there is enough.
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

/** Tries to take the port: the only reliable way to know whether it is free. */
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

// The relay is brought up BEFORE evaluating, so the report describes the final
// state and not one we have already corrected. Only when streamBaseUrl is set:
// without it the video goes out over the same origin and there is nothing to
// bring up.
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
// The ping costs up to 2 s, so it is only paid when there is an interface to test.
if (facts.tunnel === 'up') facts.tunnelPeerReachable = peerReachable()

const findings = evaluate(facts)
const level = worstLevel(findings)

console.log('\n🎬 Watchparty environment check\n')
// With everything green the detail adds nothing: only the problems are listed,
// plus a one-line summary for what is fine.
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
