import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
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
    expect(c).toEqual({ mediaFolders: [], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 })
    saveConfig({ ...c, mediaFolders: ['/pelis'] })
    expect(loadConfig().mediaFolders).toEqual(['/pelis'])
  })
})
