// Evaluación pura del estado del entorno: recibe hechos ya recolectados y
// devuelve hallazgos. Separado de la recolección (preflight.ts) porque así todo
// el criterio —qué es fatal, qué es un aviso, qué se le dice al usuario— se
// puede probar sin tocar disco, red ni procesos.

export type Level = 'ok' | 'warn' | 'fatal'

export interface Finding {
  level: Level
  title: string
  /** Qué se ha observado. */
  detail?: string
  /** Qué hacer al respecto, en imperativo. */
  fix?: string
}

export type TunnelState =
  /** Plataforma sin soporte de relevo (hoy: todo lo que no sea macOS/Windows). */
  | 'unsupported'
  /** Sin fichero de configuración: no hay relevo montado en esta máquina. */
  | 'unconfigured'
  /** Configurado pero la interfaz no está levantada. */
  | 'down'
  /** Interfaz levantada. */
  | 'up'
  /** Configurado, pero falta el programa de WireGuard. */
  | 'missing-wireguard'

export interface Facts {
  platform: string
  nodeMajor: number
  /** Los binarios empaquetados existen y son ejecutables. */
  ffmpegOk: boolean
  ffprobeOk: boolean
  /** web/dist con un index.html dentro. */
  webBuilt: boolean
  mediaFolders: string[]
  /** Subconjunto de mediaFolders que existe de verdad en disco. */
  mediaFoldersPresent: string[]
  port: number
  portFree: boolean
  /** Config del relevo; null = servir desde el mismo origen. */
  streamBaseUrl: string | null
  tunnel: TunnelState
  /** Solo significativo con tunnel === 'up'. */
  tunnelPeerReachable: boolean
  tunnelToken: string | null
  tunnelUrl: string | null
}

export const MIN_NODE = 20

const RELAY_PLATFORMS = new Set(['darwin', 'win32'])

/** Si algún hallazgo es fatal, arrancar no tiene sentido. */
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

  // Sin ffmpeg no hay nada que servir, y el fallo nativo llega tarde y mudo
  // (ffmpeg muere y la sala se queda esperando segmentos hasta el timeout).
  if (!f.ffmpegOk || !f.ffprobeOk) {
    const falta = [!f.ffmpegOk && 'ffmpeg', !f.ffprobeOk && 'ffprobe'].filter(Boolean).join(' and ')
    out.push({
      level: 'fatal',
      title: `Missing ${falta}`,
      detail: 'The binaries come from ffmpeg-static/ffprobe-static and download on install.',
      fix: 'Run `npm install` (if you already did, delete node_modules and repeat: the download may have failed).',
    })
  } else {
    out.push({ level: 'ok', title: 'ffmpeg and ffprobe bundled' })
  }

  if (!f.webBuilt) {
    // Aviso y no fatal: `npm start` compila web justo después de este chequeo.
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
      // Caso típico al mover el repo entre máquinas o al desmontar un disco
      // externo: la ruta está en la config pero no existe aquí.
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
    // El error nativo es un EADDRINUSE sin contexto; aquí se dice el puerto y
    // la causa más probable (otra instancia ya levantada).
    out.push({
      level: 'fatal',
      title: `Port ${f.port} is taken`,
      detail: 'Another Watchparty instance is probably already running.',
      fix: `Close the other instance, or change "port" in your config.json.`,
    })
  } else {
    out.push({ level: 'ok', title: `Port ${f.port} free` })
  }

  // Los dos campos del túnel de Cloudflare solo sirven juntos.
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

// El relevo del plano de datos: solo importa si está configurado. Sin
// streamBaseUrl el vídeo sale por el mismo origen que la app y no hay túnel que
// vigilar, así que no se molesta al usuario con nada.
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
      // No es fatal: el panel y la LAN funcionan igual. Pero los invitados
      // remotos se quedarían con el reproductor en negro, así que se avisa.
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

/** Render de una línea de informe, con el icono según el nivel. */
export function formatFinding(f: Finding): string {
  const icon = f.level === 'fatal' ? '❌' : f.level === 'warn' ? '⚠️ ' : '✅'
  const lines = [`${icon} ${f.title}`]
  if (f.detail) lines.push(`     ${f.detail}`)
  if (f.fix) lines.push(`     → ${f.fix}`)
  return lines.join('\n')
}
