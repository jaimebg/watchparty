import { spawn, execFileSync, ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../config.js'

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download'

export function binaryUrl(platform: NodeJS.Platform, arch: string): { url: string; archive: 'none' | 'tgz' } {
  const a = arch === 'arm64' ? 'arm64' : 'amd64'
  if (platform === 'darwin') return { url: `${RELEASES}/cloudflared-darwin-${a}.tgz`, archive: 'tgz' }
  if (platform === 'win32') return { url: `${RELEASES}/cloudflared-windows-amd64.exe`, archive: 'none' }
  return { url: `${RELEASES}/cloudflared-linux-${a}`, archive: 'none' }
}

export function parseTunnelUrl(line: string): string | null {
  return line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null
}

export async function ensureBinary(): Promise<string> {
  const binDir = join(dataDir(), 'bin')
  const bin = join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  if (existsSync(bin)) return bin
  mkdirSync(binDir, { recursive: true })
  const { url, archive } = binaryUrl(process.platform, process.arch)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Descarga de cloudflared falló: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (archive === 'tgz') {
    const tgz = join(binDir, 'cloudflared.tgz')
    writeFileSync(tgz, buf)
    execFileSync('tar', ['-xzf', tgz, '-C', binDir])
    rmSync(tgz)
  } else {
    writeFileSync(bin, buf)
  }
  if (process.platform !== 'win32') chmodSync(bin, 0o755)
  return bin
}

export class Tunnel {
  url: string | null = null
  private proc: ChildProcess | null = null
  private stopped = false
  private attempt = 0
  private starting = false
  private urlCb: ((u: string) => void) | null = null
  private downCb: (() => void) | null = null

  constructor(private port: number) {}
  onUrl(cb: (u: string) => void): void { this.urlCb = cb }
  onDown(cb: () => void): void { this.downCb = cb }

  start(): void {
    if (this.proc || this.starting) return
    this.stopped = false
    this.starting = true
    void ensureBinary().then(bin => {
      if (this.stopped) { this.starting = false; return }
      this.proc = spawn(bin, ['tunnel', '--url', `http://localhost:${this.port}`], { stdio: ['ignore', 'ignore', 'pipe'] })
      this.starting = false
      this.proc.stderr!.on('data', (d: Buffer) => {
        for (const line of d.toString().split('\n')) {
          const u = parseTunnelUrl(line)
          if (u && u !== this.url) { this.url = u; this.attempt = 0; this.urlCb?.(u) }
        }
      })
      this.proc.on('exit', () => {
        if (this.stopped) return
        this.url = null
        this.proc = null
        this.downCb?.()
        const delay = Math.min(1000 * 2 ** this.attempt++, 30_000)
        setTimeout(() => this.start(), delay)
      })
    }).catch(() => {
      if (this.stopped) { this.starting = false; return }
      this.url = null
      this.downCb?.()
      const delay = Math.min(1000 * 2 ** this.attempt++, 30_000)
      this.starting = false
      setTimeout(() => this.start(), delay)
    })
  }

  stop(): void { this.stopped = true; this.proc?.kill() }
}
