// Pure evaluation of the environment's state: it takes facts already gathered
// and returns findings. Kept apart from the gathering (preflight.ts) so that all
// the judgement — what is fatal, what is a warning, what the user is told — can
// be tested without touching disk, network or processes.

export type Level = 'ok' | 'warn' | 'fatal'

export interface Finding {
  level: Level
  title: string
  /** What was observed. */
  detail?: string
  /** What to do about it, in the imperative. */
  fix?: string
}

export type TunnelState =
  /** Platform with no relay support (today: anything other than macOS/Windows). */
  | 'unsupported'
  /** No configuration file: no relay is set up on this machine. */
  | 'unconfigured'
  /** Configured, but the interface is not up. */
  | 'down'
  /** Interface is up. */
  | 'up'
  /** Configured, but the WireGuard program is missing. */
  | 'missing-wireguard'

export interface Facts {
  platform: string
  nodeMajor: number
  /** The bundled binaries exist and are executable. */
  ffmpegOk: boolean
  ffprobeOk: boolean
  /** web/dist with an index.html inside. */
  webBuilt: boolean
  mediaFolders: string[]
  /** The subset of mediaFolders that actually exists on disk. */
  mediaFoldersPresent: string[]
  port: number
  portFree: boolean
  /** Relay config; null means serve from the same origin. */
  streamBaseUrl: string | null
  tunnel: TunnelState
  /** Only meaningful when tunnel === 'up'. */
  tunnelPeerReachable: boolean
  tunnelToken: string | null
  tunnelUrl: string | null
}

export const MIN_NODE = 20

const RELAY_PLATFORMS = new Set(['darwin', 'win32'])

/** If any finding is fatal, starting makes no sense. */
export function worstLevel(findings: Finding[]): Level {
  if (findings.some(f => f.level === 'fatal')) return 'fatal'
  if (findings.some(f => f.level === 'warn')) return 'warn'
  return 'ok'
}

export function evaluate(f: Facts): Finding[] {
  const out: Finding[] = []

  if (f.nodeMajor < MIN_NODE) {
    out.push({
      level: 'fatal',
      title: `Node ${f.nodeMajor} is too old`,
      detail: `Node ${MIN_NODE} or newer is required.`,
      fix: 'Install a modern version from https://nodejs.org and try again.',
    })
  } else {
    out.push({ level: 'ok', title: `Node ${f.nodeMajor}` })
  }

  // Without ffmpeg there is nothing to serve, and the native failure arrives
  // late and mute (ffmpeg dies and the room waits for segments until timeout).
  if (!f.ffmpegOk || !f.ffprobeOk) {
    const absent = [!f.ffmpegOk && 'ffmpeg', !f.ffprobeOk && 'ffprobe'].filter(Boolean).join(' and ')
    out.push({
      level: 'fatal',
      title: `Missing ${absent}`,
      detail: 'The binaries come from ffmpeg-static/ffprobe-static and download on install.',
      fix: 'Run `npm install` (if you already did, delete node_modules and repeat: the download may have failed).',
    })
  } else {
    out.push({ level: 'ok', title: 'ffmpeg and ffprobe bundled' })
  }

  if (!f.webBuilt) {
    // A warning and not fatal: `npm start` builds web right after this check.
    out.push({
      level: 'warn',
      title: 'Web UI not built',
      detail: 'web/dist/index.html is missing.',
      fix: '`npm start` builds it; if you start the server by hand, run `npm run build -w web` first.',
    })
  } else {
    out.push({ level: 'ok', title: 'Web UI built' })
  }

  if (f.mediaFolders.length === 0) {
    out.push({
      level: 'warn',
      title: 'No media folders configured',
      detail: 'The library will start empty.',
      fix: "In the host panel, press «📁 Add folder…» (it opens the system's native dialog).",
    })
  } else {
    const missing = f.mediaFolders.filter(p => !f.mediaFoldersPresent.includes(p))
    if (missing.length > 0) {
      // The typical case when moving the repo between machines or unmounting an
      // external drive: the path is in the config but does not exist here.
      const s = missing.length === 1 ? '' : 's'
      out.push({
        level: 'warn',
        title: `${missing.length} media folder${s} ${missing.length === 1 ? 'does not exist' : 'do not exist'}`,
        detail: missing.join(', '),
        fix: 'Remove them or pick them again from the host panel.',
      })
    }
    if (f.mediaFoldersPresent.length > 0) {
      const s = f.mediaFoldersPresent.length === 1 ? '' : 's'
      out.push({ level: 'ok', title: `${f.mediaFoldersPresent.length} media folder${s}` })
    }
  }

  if (!f.portFree) {
    // The native error is a contextless EADDRINUSE; here we name the port and
    // the likeliest cause (another instance already running).
    out.push({
      level: 'fatal',
      title: `Port ${f.port} is taken`,
      detail: 'Another Watchparty instance is probably already running.',
      fix: `Close the other instance, or change "port" in your config.json.`,
    })
  } else {
    out.push({ level: 'ok', title: `Port ${f.port} free` })
  }

  // The two Cloudflare tunnel fields are only useful together.
  if (Boolean(f.tunnelToken) !== Boolean(f.tunnelUrl)) {
    out.push({
      level: 'warn',
      title: 'Cloudflare tunnel config incomplete',
      detail: 'tunnelToken and tunnelUrl go together.',
      fix: 'Fill in the missing one, or remove both to use a Quick Tunnel with a random URL.',
    })
  }

  out.push(...evaluateRelay(f))
  return out
}

// The data-plane relay: it only matters when configured. Without streamBaseUrl
// the video goes out over the same origin as the app and there is no tunnel to
// watch, so the user is not bothered with anything.
function evaluateRelay(f: Facts): Finding[] {
  if (!f.streamBaseUrl) {
    return f.tunnel === 'up'
      ? [{
          level: 'warn',
          title: 'Relay tunnel up but unused',
          detail: 'streamBaseUrl is not configured, so video is served from the same origin as the app.',
          fix: 'Set "streamBaseUrl" in your config.json, or take the tunnel down with `npm run tunnel:down`.',
        }]
      : []
  }

  if (!RELAY_PLATFORMS.has(f.platform)) {
    return [{
      level: 'warn',
      title: 'Relay not supported on this platform',
      detail: `streamBaseUrl points at ${f.streamBaseUrl}, but I can't bring up the tunnel on ${f.platform}.`,
      fix: 'Bring the tunnel up by hand, or drop streamBaseUrl to serve from the same origin.',
    }]
  }

  switch (f.tunnel) {
    case 'missing-wireguard':
      return [{
        level: 'warn',
        title: 'WireGuard missing',
        detail: `streamBaseUrl points at ${f.streamBaseUrl}, but WireGuard isn't installed.`,
        fix: f.platform === 'win32'
          ? 'Install it from https://www.wireguard.com/install/ and launch `npm start` again.'
          : 'Run `brew install wireguard-tools` and launch `npm start` again.',
      }]
    case 'unconfigured':
      return [{
        level: 'warn',
        title: 'Relay not set up on this machine',
        detail: `streamBaseUrl points at ${f.streamBaseUrl}, but the local wg0.conf is missing.`,
        fix: 'Run `npm run setup` to generate the keys and the tunnel configuration.',
      }]
    case 'down':
      // Not fatal: the panel and the LAN work either way. But remote guests
      // would be left with a black player, so it warns.
      return [{
        level: 'warn',
        title: 'Relay tunnel is down',
        detail: 'Remote guests would get no video.',
        fix: "`npm start` tries to bring it up; manually it's `npm run tunnel:up`.",
      }]
    case 'up':
      return f.tunnelPeerReachable
        ? [{ level: 'ok', title: `Relay up toward ${f.streamBaseUrl}` }]
        : [{
            level: 'warn',
            title: 'Tunnel is up but the far end does not respond',
            detail: "The interface exists, but the VPS doesn't answer pings through the tunnel.",
            fix: 'Check that the VPS is alive, or rebuild with `npm run tunnel:down && npm run tunnel:up`.',
          }]
    default:
      return []
  }
}

/** Renders one report line, with the icon matching the level. */
export function formatFinding(f: Finding): string {
  const icon = f.level === 'fatal' ? '❌' : f.level === 'warn' ? '⚠️ ' : '✅'
  const lines = [`${icon} ${f.title}`]
  if (f.detail) lines.push(`     ${f.detail}`)
  if (f.fix) lines.push(`     → ${f.fix}`)
  return lines.join('\n')
}
