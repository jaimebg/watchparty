import { describe, it, expect } from 'vitest'
import { binaryUrl, parseTunnelUrl } from '../src/tunnel/cloudflared.js'

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
