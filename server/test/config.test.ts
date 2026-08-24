import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataDir, loadConfig, saveConfig, cacheDir } from '../src/config.js'

const FACTORY = {
  mediaFolders: [], klipyApiKey: null, tmdbApiKey: null, tunnelToken: null, tunnelUrl: null,
  streamBaseUrl: null,
  relayPeerPublicKey: null, relayEndpoint: null, relayPeerIp: null, relayLocalIp: '10.77.0.2',
  port: 8400, hostName: 'Host', cacheLimitGB: 10,
}

describe('config', () => {
  const noDefaults = process.env.JBG_DEFAULTS_FILE!

  beforeEach(() => { process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'jbg-')) })
  afterEach(() => { process.env.JBG_DEFAULTS_FILE = noDefaults })

  /** Writes a repo-level config.defaults.json and points config.ts at it. */
  const withRepoDefaults = (defaults: Record<string, unknown>) => {
    const path = join(mkdtempSync(join(tmpdir(), 'jbg-repo-')), 'config.defaults.json')
    writeFileSync(path, JSON.stringify(defaults))
    process.env.JBG_DEFAULTS_FILE = path
    return path
  }

  it('dataDir respects JBG_DATA_DIR', () => {
    expect(dataDir()).toBe(process.env.JBG_DATA_DIR)
    expect(cacheDir()).toBe(join(dataDir(), 'cache'))
  })

  it('loadConfig creates defaults and roundtrips', () => {
    const c = loadConfig()
    expect(c).toEqual(FACTORY)
    saveConfig({ ...c, mediaFolders: ['/movies'] })
    expect(loadConfig().mediaFolders).toEqual(['/movies'])
  })

  it('loadConfig throws a clear, actionable error when config.json is corrupted', () => {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'config.json')
    writeFileSync(path, '{ not valid json')
    expect(() => loadConfig()).toThrow(new RegExp(`invalid config\\.json at ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })

  it('takes the keys from the repo\'s config.defaults.json when there is no local config', () => {
    withRepoDefaults({ klipyApiKey: 'k-repo', tmdbApiKey: 't-repo', tunnelUrl: 'https://fixed.example', port: 9000 })
    const c = loadConfig()
    expect(c.klipyApiKey).toBe('k-repo')
    expect(c.tmdbApiKey).toBe('t-repo')
    expect(c.tunnelUrl).toBe('https://fixed.example')
    expect(c.port).toBe(9000)
    expect(c.mediaFolders).toEqual([]) // what is machine-specific stays empty
  })

  it('the local config overrides the repo one, but its nulls do not erase the shared keys', () => {
    withRepoDefaults({ klipyApiKey: 'k-repo', hostName: 'Living room' })
    writeFileSync(join(dataDir(), 'config.json'), JSON.stringify({ klipyApiKey: null, hostName: 'Laptop', mediaFolders: ['/local'] }))
    const c = loadConfig()
    expect(c.klipyApiKey).toBe('k-repo') // null means "not configured", it does not override
    expect(c.hostName).toBe('Laptop')
    expect(c.mediaFolders).toEqual(['/local'])
  })

  it('saveConfig only persists what differs from the repo, so a rotated key propagates', () => {
    const repo = withRepoDefaults({ klipyApiKey: 'k-old', tmdbApiKey: 't-repo' })
    saveConfig({ ...loadConfig(), mediaFolders: ['/movies'] })

    const local = JSON.parse(readFileSync(join(dataDir(), 'config.json'), 'utf8'))
    expect(local).toEqual({ mediaFolders: ['/movies'] })
    expect(local.klipyApiKey).toBeUndefined() // no local copy of the key is frozen in

    writeFileSync(repo, JSON.stringify({ klipyApiKey: 'k-new', tmdbApiKey: 't-repo' }))
    expect(loadConfig().klipyApiKey).toBe('k-new')
    expect(loadConfig().mediaFolders).toEqual(['/movies'])
  })
})
