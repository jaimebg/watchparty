import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

export function loadConfig(): Config {
  mkdirSync(dataDir(), { recursive: true })
  if (!existsSync(configPath())) writeFileSync(configPath(), JSON.stringify(DEFAULTS, null, 2))
  const raw = readFileSync(configPath(), 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`config.json inválido en ${configPath()}: ${msg}`)
  }
  return { ...DEFAULTS, ...(parsed as Partial<Config>) }
}

export function saveConfig(c: Config): void {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(c, null, 2))
}
