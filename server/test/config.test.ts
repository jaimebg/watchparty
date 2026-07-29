import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataDir, loadConfig, saveConfig, cacheDir } from '../src/config.js'

const FACTORY = { mediaFolders: [], klipyApiKey: null, tmdbApiKey: null, tunnelToken: null, tunnelUrl: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 }

describe('config', () => {
  const noDefaults = process.env.JBG_DEFAULTS_FILE!

  beforeEach(() => { process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'jbg-')) })
  afterEach(() => { process.env.JBG_DEFAULTS_FILE = noDefaults })

  /** Escribe un config.defaults.json de repo y hace que config.ts lo use. */
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
    saveConfig({ ...c, mediaFolders: ['/pelis'] })
    expect(loadConfig().mediaFolders).toEqual(['/pelis'])
  })

  it('loadConfig throws a clear, actionable error when config.json is corrupted', () => {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'config.json')
    writeFileSync(path, '{ not valid json')
    expect(() => loadConfig()).toThrow(new RegExp(`config\\.json inválido en ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })

  it('toma las keys del config.defaults.json del repo cuando no hay config local', () => {
    withRepoDefaults({ klipyApiKey: 'k-repo', tmdbApiKey: 't-repo', tunnelUrl: 'https://fija.example', port: 9000 })
    const c = loadConfig()
    expect(c.klipyApiKey).toBe('k-repo')
    expect(c.tmdbApiKey).toBe('t-repo')
    expect(c.tunnelUrl).toBe('https://fija.example')
    expect(c.port).toBe(9000)
    expect(c.mediaFolders).toEqual([]) // lo específico de la máquina sigue vacío
  })

  it('el config local pisa al del repo, pero sus nulos no borran las keys compartidas', () => {
    withRepoDefaults({ klipyApiKey: 'k-repo', hostName: 'Salón' })
    writeFileSync(join(dataDir(), 'config.json'), JSON.stringify({ klipyApiKey: null, hostName: 'Portátil', mediaFolders: ['/local'] }))
    const c = loadConfig()
    expect(c.klipyApiKey).toBe('k-repo') // null = «sin configurar», no pisa
    expect(c.hostName).toBe('Portátil')
    expect(c.mediaFolders).toEqual(['/local'])
  })

  it('saveConfig solo persiste lo que difiere del repo, así una key rotada se propaga', () => {
    const repo = withRepoDefaults({ klipyApiKey: 'k-vieja', tmdbApiKey: 't-repo' })
    saveConfig({ ...loadConfig(), mediaFolders: ['/pelis'] })

    const local = JSON.parse(readFileSync(join(dataDir(), 'config.json'), 'utf8'))
    expect(local).toEqual({ mediaFolders: ['/pelis'] })
    expect(local.klipyApiKey).toBeUndefined() // no se congela una copia local de la key

    writeFileSync(repo, JSON.stringify({ klipyApiKey: 'k-nueva', tmdbApiKey: 't-repo' }))
    expect(loadConfig().klipyApiKey).toBe('k-nueva')
    expect(loadConfig().mediaFolders).toEqual(['/pelis'])
  })
})
