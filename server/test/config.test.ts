import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataDir, loadConfig, saveConfig, cacheDir } from '../src/config.js'

describe('config', () => {
  beforeEach(() => { process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'jbg-')) })

  it('dataDir respects JBG_DATA_DIR', () => {
    expect(dataDir()).toBe(process.env.JBG_DATA_DIR)
    expect(cacheDir()).toBe(join(dataDir(), 'cache'))
  })

  it('loadConfig creates defaults and roundtrips', () => {
    const c = loadConfig()
    expect(c).toEqual({ mediaFolders: [], klipyApiKey: null, tmdbApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 })
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
})
