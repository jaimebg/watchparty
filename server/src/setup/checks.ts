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
      title: `Node ${f.nodeMajor} es demasiado antiguo`,
      detail: `Hace falta Node ${MIN_NODE} o superior.`,
      fix: 'Instala una versión moderna desde https://nodejs.org y vuelve a intentarlo.',
    })
  } else {
    out.push({ level: 'ok', title: `Node ${f.nodeMajor}` })
  }

  // Sin ffmpeg no hay nada que servir, y el fallo nativo llega tarde y mudo
  // (ffmpeg muere y la sala se queda esperando segmentos hasta el timeout).
  if (!f.ffmpegOk || !f.ffprobeOk) {
    const falta = [!f.ffmpegOk && 'ffmpeg', !f.ffprobeOk && 'ffprobe'].filter(Boolean).join(' y ')
    out.push({
      level: 'fatal',
      title: `Falta ${falta}`,
      detail: 'Los binarios vienen de ffmpeg-static/ffprobe-static y se descargan al instalar.',
      fix: 'Ejecuta `npm install` (si ya lo hiciste, borra node_modules y repite: la descarga pudo fallar).',
    })
  } else {
    out.push({ level: 'ok', title: 'ffmpeg y ffprobe empaquetados' })
  }

  if (!f.webBuilt) {
    // Aviso y no fatal: `npm start` compila web justo después de este chequeo.
    out.push({
      level: 'warn',
      title: 'La interfaz web no está compilada',
      detail: 'No hay web/dist/index.html.',
      fix: '`npm start` la compila; si arrancas el server a mano, lanza antes `npm run build -w web`.',
    })
  } else {
    out.push({ level: 'ok', title: 'Interfaz web compilada' })
  }

  if (f.mediaFolders.length === 0) {
    out.push({
      level: 'warn',
      title: 'Sin carpetas de medios configuradas',
      detail: 'La biblioteca arrancará vacía.',
      fix: 'En el panel del host, pulsa «📁 Elegir carpeta…» — abre el diálogo nativo del sistema.',
    })
  } else {
    const missing = f.mediaFolders.filter(p => !f.mediaFoldersPresent.includes(p))
    if (missing.length > 0) {
      // Caso típico al mover el repo entre máquinas o al desmontar un disco
      // externo: la ruta está en la config pero no existe aquí.
      out.push({
        level: 'warn',
        title: `${missing.length} carpeta(s) de medios no existen`,
        detail: missing.join(', '),
        fix: 'Quítalas o vuelve a elegirlas desde el panel del host.',
      })
    }
    if (f.mediaFoldersPresent.length > 0) {
      out.push({ level: 'ok', title: `${f.mediaFoldersPresent.length} carpeta(s) de medios` })
    }
  }

  if (!f.portFree) {
    // El error nativo es un EADDRINUSE sin contexto; aquí se dice el puerto y
    // la causa más probable (otra instancia ya levantada).
    out.push({
      level: 'fatal',
      title: `El puerto ${f.port} está ocupado`,
      detail: 'Probablemente ya hay otra instancia de jbg-watchparty corriendo.',
      fix: `Cierra la otra instancia, o cambia "port" en tu config.json.`,
    })
  } else {
    out.push({ level: 'ok', title: `Puerto ${f.port} libre` })
  }

  // Los dos campos del túnel de Cloudflare solo sirven juntos.
  if (Boolean(f.tunnelToken) !== Boolean(f.tunnelUrl)) {
    out.push({
      level: 'warn',
      title: 'Config del túnel de Cloudflare incompleta',
      detail: 'tunnelToken y tunnelUrl deben ir juntos.',
      fix: 'Rellena el que falta, o borra los dos para usar un Quick Tunnel con URL aleatoria.',
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
          title: 'Túnel del relevo activo pero sin usar',
          detail: 'streamBaseUrl no está configurado, así que el vídeo sale por el mismo origen que la app.',
          fix: 'Pon "streamBaseUrl" en tu config.json, o baja el túnel con `npm run tunnel:down`.',
        }]
      : []
  }

  if (!RELAY_PLATFORMS.has(f.platform)) {
    return [{
      level: 'warn',
      title: 'El relevo no está soportado en esta plataforma',
      detail: `streamBaseUrl apunta a ${f.streamBaseUrl}, pero no sé levantar el túnel en ${f.platform}.`,
      fix: 'Levanta el túnel a mano, o quita streamBaseUrl para servir desde el mismo origen.',
    }]
  }

  switch (f.tunnel) {
    case 'missing-wireguard':
      return [{
        level: 'warn',
        title: 'Falta WireGuard',
        detail: `streamBaseUrl apunta a ${f.streamBaseUrl}, pero WireGuard no está instalado.`,
        fix: f.platform === 'win32'
          ? 'Instálalo desde https://www.wireguard.com/install/ y vuelve a lanzar `npm start`.'
          : 'Ejecuta `brew install wireguard-tools` y vuelve a lanzar `npm start`.',
      }]
    case 'unconfigured':
      return [{
        level: 'warn',
        title: 'Relevo sin configurar en esta máquina',
        detail: `streamBaseUrl apunta a ${f.streamBaseUrl}, pero falta el wg0.conf local.`,
        fix: 'Ejecuta `npm run setup` para generar las claves y la configuración del túnel.',
      }]
    case 'down':
      // No es fatal: el panel y la LAN funcionan igual. Pero los invitados
      // remotos se quedarían con el reproductor en negro, así que se avisa.
      return [{
        level: 'warn',
        title: 'El túnel del relevo está bajado',
        detail: 'Los invitados remotos no verían vídeo.',
        fix: '`npm start` intenta levantarlo; a mano es `npm run tunnel:up`.',
      }]
    case 'up':
      return f.tunnelPeerReachable
        ? [{ level: 'ok', title: `Relevo activo hacia ${f.streamBaseUrl}` }]
        : [{
            level: 'warn',
            title: 'Túnel levantado pero el otro extremo no responde',
            detail: 'La interfaz existe, pero el VPS no contesta al ping por el túnel.',
            fix: 'Comprueba que el VPS está vivo, o reconstruye con `npm run tunnel:down && npm run tunnel:up`.',
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
