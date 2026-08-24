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
  // Origin the clients fetch video from (segments, init, VTT), when it is not the
  // one serving the app. Separates the data plane from the control plane: the
  // HTML/API/WebSocket keep coming in through the Cloudflare tunnel (what its CDN
  // is meant for, and negligible traffic), while the video gigabytes go out over a
  // relay of our own. Needed because Cloudflare's CDN terms for Free/Pro/Business
  // plans reserve the right to limit service for anyone using it to serve video
  // hosted outside Cloudflare, and a tunnel hostname is a CNAME to
  // cfargotunnel.com that ONLY resolves through the proxy: it cannot be
  // grey-routed, so every byte goes through the CDN by construction.
  // null = same origin, which is the right answer on a LAN and with no relay.
  streamBaseUrl?: string | null
  // Relay details, so `npm run setup` can bring the tunnel up on a new machine
  // without anyone having to remember anything. They describe the VPS rather than
  // the machine, and none of them is secret (a public key and an endpoint), so
  // multi-machine owners may keep them in the shared layer (config.defaults.json).
  /** WireGuard public key of the VPS. */
  relayPeerPublicKey?: string | null
  /** UDP `host:port` the VPS listens on, e.g. `1.2.3.4:51820`. */
  relayEndpoint?: string | null
  /** The VPS's IP inside the tunnel. */
  relayPeerIp?: string | null
  /**
   * THIS machine's IP inside the tunnel. Fixed on purpose rather than one per
   * host: the VPS's `reverse_proxy` points at a single address, so changing it
   * would mean reconfiguring the VPS for every host. It serves one machine at a
   * time, so `npm run setup` replaces the peer on the VPS instead of adding one.
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

// config.defaults.json is versioned in the repo, so a clone arrives with sane
// defaults. It is public: it holds only non-secret values. API keys and tunnel
// tokens belong in the local config.json (see loadConfig below).
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

// null/undefined means "not configured": it does not override the layer below.
function overlay(base: Config, patch: Partial<Config>): Config {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) if (v !== null && v !== undefined) Reflect.set(out, k, v)
  return out
}

/** Shared layer: factory values plus whatever is versioned in the repo. */
function baseConfig(): Config {
  const path = defaultsPath()
  return path && existsSync(path) ? overlay(DEFAULTS, readJson(path)) : DEFAULTS
}

export function loadConfig(): Config {
  mkdirSync(dataDir(), { recursive: true })
  // The local config carries only what is specific to this machine; the rest
  // comes from the repo.
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
