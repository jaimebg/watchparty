import { describe, it, expect } from 'vitest'
import { binaryUrl, parseNamedReady, parseTunnelUrl, tunnelArgs } from '../src/tunnel/cloudflared.js'

describe('binaryUrl', () => {
  it('darwin arm64 is a tgz', () => {
    const r = binaryUrl('darwin', 'arm64')
    expect(r.url).toContain('cloudflared-darwin-arm64.tgz')
    expect(r.archive).toBe('tgz')
  })
  it('windows is a plain exe', () => {
    const r = binaryUrl('win32', 'x64')
    expect(r.url).toContain('cloudflared-windows-amd64.exe')
    expect(r.archive).toBe('none')
  })
})

describe('parseTunnelUrl', () => {
  it('extracts trycloudflare url from log line', () => {
    expect(parseTunnelUrl('2026-07-28 INF |  https://tos-abc-123.trycloudflare.com  |')).toBe('https://tos-abc-123.trycloudflare.com')
    expect(parseTunnelUrl('otra línea')).toBeNull()
  })
})

describe('parseNamedReady', () => {
  it('detects the registered-connection log line', () => {
    expect(parseNamedReady('2026-07-29T09:00:00Z INF Registered tunnel connection connIndex=0 location=MAD protocol=quic')).toBe(true)
  })
  it('ignores other lines', () => {
    expect(parseNamedReady('2026-07-29T09:00:00Z INF Starting tunnel tunnelID=2a23c91d')).toBe(false)
    expect(parseNamedReady('')).toBe(false)
  })
})

describe('tunnelArgs', () => {
  it('quick tunnel without token', () => {
    expect(tunnelArgs(8400)).toEqual(['tunnel', '--url', 'http://localhost:8400'])
  })
  it('named tunnel with token', () => {
    expect(tunnelArgs(8400, 'tok123')).toEqual(['tunnel', 'run', '--token', 'tok123'])
  })
})
