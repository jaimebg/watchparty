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
  port: number
  hostName: string
  cacheLimitGB: number
}

const DEFAULTS: Config = { mediaFolders: [], klipyApiKey: null, tmdbApiKey: null, tunnelToken: null, tunnelUrl: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 }

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
    throw new Error(`${basename(path)} inválido en ${path}: ${msg}`)
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
