import { describe, it, expect } from 'vitest'
import { evaluate, formatFinding, worstLevel, type Facts, type Finding } from '../src/setup/checks.js'

// A healthy environment: every test starts from here and breaks ONE thing, so
// the finding being checked cannot come from anywhere else.
const healthy: Facts = {
  platform: 'darwin',
  nodeMajor: 22,
  ffmpegOk: true,
  ffprobeOk: true,
  webBuilt: true,
  mediaFolders: ['/movies'],
  mediaFoldersPresent: ['/movies'],
  port: 8400,
  portFree: true,
  streamBaseUrl: null,
  tunnel: 'unconfigured',
  tunnelPeerReachable: false,
  tunnelToken: 'tok',
  tunnelUrl: 'https://x.example',
}

const of = (f: Partial<Facts>): Finding[] => evaluate({ ...healthy, ...f })
const titles = (fs: Finding[]): string => fs.map(f => f.title).join(' | ')
const problems = (fs: Finding[]): Finding[] => fs.filter(f => f.level !== 'ok')

describe('evaluate', () => {
  it('a healthy environment produces not one warning', () => {
    expect(problems(of({}))).toEqual([])
    expect(worstLevel(of({}))).toBe('ok')
  })

  it('Node below the minimum is fatal', () => {
    const fs = of({ nodeMajor: 18 })
    expect(worstLevel(fs)).toBe('fatal')
    expect(titles(fs)).toContain('Node 18 is too old')
  })

  it('missing ffmpeg or ffprobe is fatal, and it says which one', () => {
    expect(worstLevel(of({ ffmpegOk: false }))).toBe('fatal')
    expect(titles(of({ ffmpegOk: false }))).toContain('Missing ffmpeg')
    expect(titles(of({ ffprobeOk: false }))).toContain('Missing ffprobe')
    expect(titles(of({ ffmpegOk: false, ffprobeOk: false }))).toContain('Missing ffmpeg and ffprobe')
  })

  // The native failure is a contextless EADDRINUSE, and the cause is almost
  // always a second instance: worth stopping earlier with a message that says so.
  it('a taken port is fatal', () => {
    const fs = of({ portFree: false })
    expect(worstLevel(fs)).toBe('fatal')
    expect(titles(fs)).toContain('Port 8400 is taken')
  })

  it('an unbuilt web UI only warns (npm start builds it)', () => {
    expect(worstLevel(of({ webBuilt: false }))).toBe('warn')
  })

  it('warns about an empty library and about folders that no longer exist', () => {
    expect(titles(of({ mediaFolders: [], mediaFoldersPresent: [] })))
      .toContain('No media folders configured')
    const gone = of({ mediaFolders: ['/movies', '/usb'], mediaFoldersPresent: ['/movies'] })
    expect(titles(gone)).toContain('1 media folder does not exist')
    expect(problems(gone)[0].detail).toBe('/usb')
  })

  it('warns when tunnelToken and tunnelUrl do not come as a pair', () => {
    expect(titles(of({ tunnelUrl: null }))).toContain('Cloudflare tunnel config incomplete')
    expect(titles(of({ tunnelToken: null }))).toContain('Cloudflare tunnel config incomplete')
    // Both absent is valid: it means Quick Tunnel.
    expect(problems(of({ tunnelToken: null, tunnelUrl: null }))).toEqual([])
  })
})

describe('evaluate — relay', () => {
  const withRelay = (extra: Partial<Facts>) => of({ streamBaseUrl: 'https://stream.example', ...extra })

  // Without streamBaseUrl there is no relay to watch: the user is left alone.
  it('stays quiet when no relay is configured', () => {
    expect(problems(of({ tunnel: 'down' }))).toEqual([])
    expect(problems(of({ tunnel: 'missing-wireguard' }))).toEqual([])
  })

  // But a tunnel that is up and unused is odd and worth saying: it costs and
  // serves nothing.
  it('warns about a tunnel that is up and unused', () => {
    expect(titles(of({ tunnel: 'up' }))).toContain('Relay tunnel up but unused')
  })

  it('a healthy relay is an OK and nothing else', () => {
    const fs = withRelay({ tunnel: 'up', tunnelPeerReachable: true })
    expect(problems(fs)).toEqual([])
    expect(titles(fs)).toContain('Relay up toward https://stream.example')
  })

  // The distinction that matters: the interface can exist with the VPS dead, and
  // that looks exactly like "all good" if you only check the interface name.
  it('tells an interface being up apart from the far end being reachable', () => {
    const fs = withRelay({ tunnel: 'up', tunnelPeerReachable: false })
    expect(worstLevel(fs)).toBe('warn')
    expect(titles(fs)).toContain('the far end does not respond')
  })

  it('a down tunnel warns but never blocks startup', () => {
    // The panel and the LAN keep working: making it fatal would leave the host
    // unable to watch anything over a problem that only affects guests.
    const fs = withRelay({ tunnel: 'down' })
    expect(worstLevel(fs)).toBe('warn')
  })

  it('gives each platform its own install instruction', () => {
    const mac = problems(withRelay({ tunnel: 'missing-wireguard', platform: 'darwin' }))
    expect(mac[0].fix).toContain('brew install wireguard-tools')
    const win = problems(withRelay({ tunnel: 'missing-wireguard', platform: 'win32' }))
    expect(win[0].fix).toContain('wireguard.com/install')
  })

  it('points at `npm run setup` when the local tunnel config is missing', () => {
    expect(problems(withRelay({ tunnel: 'unconfigured' }))[0].fix).toContain('npm run setup')
  })

  it('warns on platforms where we cannot bring the tunnel up', () => {
    const fs = withRelay({ platform: 'linux', tunnel: 'unsupported' })
    expect(titles(fs)).toContain('Relay not supported on this platform')
  })
})

describe('formatFinding', () => {
  it('marks the level with an icon and indents detail and fix', () => {
    const out = formatFinding({ level: 'fatal', title: 'Broken', detail: 'because', fix: 'fix it' })
    expect(out.split('\n')[0]).toBe('❌ Broken')
    expect(out).toContain('     because')
    expect(out).toContain('     → fix it')
  })

  it('an OK with no detail is a single line', () => {
    expect(formatFinding({ level: 'ok', title: 'Node 22' })).toBe('✅ Node 22')
  })
})

describe('worstLevel', () => {
  it('fatal beats warn, and warn beats ok', () => {
    expect(worstLevel([{ level: 'ok', title: 'a' }, { level: 'warn', title: 'b' }])).toBe('warn')
    expect(worstLevel([{ level: 'warn', title: 'a' }, { level: 'fatal', title: 'b' }])).toBe('fatal')
    expect(worstLevel([])).toBe('ok')
  })
})
