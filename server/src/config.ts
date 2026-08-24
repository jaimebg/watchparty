import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Config {
  mediaFolders: string[]
  klipyApiKey: string | null
  tmdbApiKey?: string | null
  tunnelToken?: string | null
  tunnelUrl?: string | null
  // Origen desde el que los clientes piden el vídeo (segmentos, init, VTT), si
  // no es el mismo que sirve la app. Separa el plano de datos del de control:
  // el HTML/API/WebSocket siguen entrando por el túnel de Cloudflare (uso para
  // el que su CDN está pensado y tráfico despreciable), mientras los megas de
  // vídeo salen por un relevo propio. Hace falta porque los términos del CDN de
  // Cloudflare para planes Free/Pro/Business se reservan el derecho a limitar el
  // servicio a quien lo use para servir vídeo alojado fuera de Cloudflare, y el
  // hostname de un túnel es un CNAME a cfargotunnel.com que SOLO resuelve a
  // través del proxy: no se puede dejar en gris, así que todos los bytes pasan
  // por el CDN por construcción.
  // null = mismo origen, que es lo correcto en LAN y sin relevo montado.
  streamBaseUrl?: string | null
  // Datos del relevo, para que `npm run setup` pueda montar el túnel en una
  // máquina nueva sin que nadie recuerde nada. Van en la capa compartida
  // (config.defaults.json) porque describen el VPS, no la máquina: ninguno es
  // secreto —una clave pública y un endpoint— y así viajan con el clon.
  /** Clave pública WireGuard del VPS. */
  relayPeerPublicKey?: string | null
  /** `host:puerto` UDP donde escucha el VPS, p. ej. `1.2.3.4:51820`. */
  relayEndpoint?: string | null
  /** IP del VPS dentro del túnel. */
  relayPeerIp?: string | null
  /**
   * IP de ESTA máquina dentro del túnel. Fija a propósito y no una por host: el
   * `reverse_proxy` del VPS apunta a una sola dirección, así que cambiarla
   * obligaría a reconfigurar el VPS por cada host. Solo sirve una máquina a la
   * vez, así que `npm run setup` reemplaza el peer en el VPS en lugar de añadirlo.
   */
  relayLocalIp?: string | null
  port: number
  hostName: string
  cacheLimitGB: number
}

const DEFAULTS: Config = {
  mediaFolders: [], klipyApiKey: null, tmdbApiKey: null, tunnelToken: null, tunnelUrl: null,
  streamBaseUrl: null,
  relayPeerPublicKey: null, relayEndpoint: null, relayPeerIp: null, relayLocalIp: '10.77.0.2',
  port: 8400, hostName: 'Host', cacheLimitGB: 10,
}

export function dataDir(): string {
  if (process.env.JBG_DATA_DIR) return process.env.JBG_DATA_DIR
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jbg-watchparty')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jbg-watchparty')
  return join(homedir(), '.local', 'share', 'jbg-watchparty')
}

export const cacheDir = () => join(dataDir(), 'cache')
const configPath = () => join(dataDir(), 'config.json')

// config.defaults.json vive en el repo (privado): así las API keys y el túnel
// viajan con el clon y no hay que reconfigurar nada en cada máquina.
function defaultsPath(): string | null {
  if (process.env.JBG_DEFAULTS_FILE) return process.env.JBG_DEFAULTS_FILE
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'config.defaults.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function readJson(path: string): Partial<Config> {
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw) as Partial<Config>
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`invalid ${basename(path)} at ${path}: ${msg}`)
  }
}

// null/undefined = «sin configurar»: no pisa la capa de debajo.
function overlay(base: Config, patch: Partial<Config>): Config {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) if (v !== null && v !== undefined) Reflect.set(out, k, v)
  return out
}

/** Capa compartida: valores de fábrica + lo versionado en el repo. */
function baseConfig(): Config {
  const path = defaultsPath()
  return path && existsSync(path) ? overlay(DEFAULTS, readJson(path)) : DEFAULTS
}

export function loadConfig(): Config {
  mkdirSync(dataDir(), { recursive: true })
  // El config local solo lleva lo propio de esta máquina; lo demás sale del repo.
  if (!existsSync(configPath())) writeFileSync(configPath(), JSON.stringify({ mediaFolders: [] }, null, 2))
  return overlay(baseConfig(), readJson(configPath()))
}

export function saveConfig(c: Config): void {
  mkdirSync(dataDir(), { recursive: true })
  const base = baseConfig()
  const local: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(c)) {
    if (JSON.stringify(v) !== JSON.stringify(Reflect.get(base, k))) local[k] = v
  }
  writeFileSync(configPath(), JSON.stringify(local, null, 2))
}
