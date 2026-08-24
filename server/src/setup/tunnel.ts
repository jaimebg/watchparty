// The data-plane relay's WireGuard tunnel, on macOS and Windows.
//
// It hangs off `npm start` rather than a boot service because the tunnel is only
// needed while there is a session. Two decisions keep it out of the way:
//
//   - It only asks for elevation when the tunnel is NOT already up. Starting the
//     server twice the same afternoon does not ask again.
//   - It is not taken down when done. An idle tunnel costs one packet every 25 s,
//     and tearing it down would force a second authentication per session. To
//     take it down by hand: `npm run tunnel:down`.
//
// On elevation: it goes through the system dialog (osascript on macOS, UAC on
// Windows) and NOT through a passwordless sudo rule. On macOS the Homebrew prefix
// is user-writable, so granting passwordless sudo to a binary that same user
// could replace would be a root escalation for any process running as them.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { dataDir } from '../config.js'
import type { TunnelState } from './checks.js'

export const IFACE = 'wg0'

/** The tunnel's addresses, read from wg0.conf itself so the subnet is not pinned here. */
export interface TunnelAddresses { local: string | null; peer: string | null }

/**
 * `Address` is this end's IP; the other end's comes from `AllowedIPs`, which in
 * this topology is exactly the VPS's /32. They are read from the file rather than
 * hard-coded so that changing subnet does not require touching this module.
 */
export function parseConfAddresses(conf: string): TunnelAddresses {
  const strip = (v: string): string => v.trim().split('/')[0].trim()
  const address = conf.match(/^\s*Address\s*=\s*([^\s,]+)/mi)
  const allowed = conf.match(/^\s*AllowedIPs\s*=\s*([^\s,]+)/mi)
  return {
    local: address ? strip(address[1]) : null,
    peer: allowed ? strip(allowed[1]) : null,
  }
}

/**
 * The private key from the `.conf`, so the public one can be derived without
 * privileges. `wg show <iface> public-key` would do the same, but on macOS it
 * needs root: it reads the control socket in /var/run/wireguard.
 */
export function parseConfPrivateKey(conf: string): string | null {
  return conf.match(/^\s*PrivateKey\s*=\s*(\S+)/mi)?.[1] ?? null
}

/**
 * The `utun` number changes between boots, so the interface is recognised by its
 * address rather than by its name.
 */
export function interfaceHasAddress(ifconfigOutput: string, ip: string): boolean {
  if (!ip) return false
  // Anchored at a word boundary: without this, 10.77.0.1 would match 10.77.0.10.
  return new RegExp(`inet\\s+${ip.replace(/\./g, '\\.')}(?![0-9.])`).test(ifconfigOutput)
}

/** The only part of `os.networkInterfaces()` we need. */
export type InterfaceAddresses = Record<string, readonly { address: string }[] | undefined>

/**
 * The Windows counterpart of interfaceHasAddress, asking the system instead of a
 * command: `sc query` would say the same, but it translates its labels — a
 * Spanish Windows prints `ESTADO : 4  RUNNING` — and looking for "STATE" reported
 * a live tunnel as down. Here there is no text to interpret, and as a bonus it
 * checks what actually matters (that the address is assigned) rather than that
 * the service exists.
 */
export function addressIsAssigned(ifaces: InterfaceAddresses, ip: string): boolean {
  if (!ip) return false
  return Object.values(ifaces).some(addrs => addrs?.some(a => a.address === ip))
}

// ---------------------------------------------------------------------------
// Per-platform paths
// ---------------------------------------------------------------------------

/** Homebrew prefix: Apple Silicon uses /opt/homebrew, Intel /usr/local. */
function brewPrefix(): string | null {
  for (const p of ['/opt/homebrew', '/usr/local']) if (existsSync(join(p, 'bin', 'wg-quick'))) return p
  return null
}

const WINDOWS_WIREGUARD = 'C:\\Program Files\\WireGuard\\wireguard.exe'

/**
 * On macOS the file has to live in one of the paths wg-quick looks in; on Windows
 * it goes where the app's config already lives, because there we hand it to
 * `wireguard.exe` by full path and there is no convention to respect.
 */
export function confPath(): string {
  if (process.platform === 'win32') return join(dataDir(), 'wireguard', `${IFACE}.conf`)
  const prefix = brewPrefix() ?? '/opt/homebrew'
  return join(prefix, 'etc', 'wireguard', `${IFACE}.conf`)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function quiet(bin: string, args: string[]): string {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

export function tunnelState(): TunnelState {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'unsupported'
  if (!existsSync(confPath())) return 'unconfigured'

  if (process.platform === 'win32') {
    if (!existsSync(WINDOWS_WIREGUARD)) return 'missing-wireguard'
    const { local } = addresses()
    if (!local) return 'down'
    return addressIsAssigned(networkInterfaces(), local) ? 'up' : 'down'
  }

  if (!brewPrefix()) return 'missing-wireguard'
  const { local } = addresses()
  if (!local) return 'down'
  return interfaceHasAddress(quiet('/sbin/ifconfig', ['-a']), local) ? 'up' : 'down'
}

export function addresses(): TunnelAddresses {
  const path = confPath()
  if (!existsSync(path)) return { local: null, peer: null }
  try {
    return parseConfAddresses(readFileSync(path, 'utf8'))
  } catch {
    return { local: null, peer: null }
  }
}

/**
 * An interface being up does not mean the far end is alive (VPS down, host's
 * network changed). A ping does prove it, and needs no privileges.
 */
export function peerReachable(): boolean {
  const { peer } = addresses()
  if (!peer) return false
  // Windows measures the timeout in ms with -w; macOS with -W, and counts with -n/-c.
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', '2000', peer]
    : ['-c', '1', '-W', '2000', peer]
  try {
    execFileSync(process.platform === 'win32' ? 'ping' : '/sbin/ping', args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Bringing up and down (with elevation)
// ---------------------------------------------------------------------------

function elevateMac(verb: 'up' | 'down'): void {
  const prefix = brewPrefix()
  if (!prefix) throw new Error('WireGuard is not installed (wg-quick missing)')
  // Explicit PATH and brew's bash forced in: wg-quick carries an `env bash`
  // shebang and the system's bash 3.2 rejects it on its first check; it also
  // needs to find `wg` and `wireguard-go` from the same prefix.
  const inner = `PATH=${prefix}/bin:/usr/bin:/bin:/usr/sbin:/sbin ${prefix}/bin/bash ${prefix}/bin/wg-quick ${verb} ${IFACE} 2>&1`
  const script = `do shell script "${inner.replace(/"/g, '\\"')}" with administrator privileges`
  execFileSync('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'ignore', 'inherit'] })
}

function elevateWindows(verb: 'up' | 'down'): void {
  if (!existsSync(WINDOWS_WIREGUARD)) throw new Error('WireGuard for Windows is not installed')
  // /installtunnelservice registers the tunnel as a service (so it survives this
  // console closing); /uninstalltunnelservice removes it. Both require an
  // administrator, hence the -Verb RunAs that triggers UAC.
  const args = verb === 'up'
    ? `'/installtunnelservice','${confPath()}'`
    : `'/uninstalltunnelservice','${IFACE}'`
  const ps = `Start-Process -FilePath '${WINDOWS_WIREGUARD}' -ArgumentList ${args} -Verb RunAs -Wait`
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'ignore', 'inherit'] })
}

function elevate(verb: 'up' | 'down'): void {
  if (process.platform === 'win32') elevateWindows(verb)
  else elevateMac(verb)
}

export interface TunnelResult { ok: boolean; message: string }

export function bringUp(): TunnelResult {
  const state = tunnelState()
  if (state === 'unsupported') return { ok: false, message: `No relay support on ${process.platform}.` }
  if (state === 'unconfigured') return { ok: false, message: 'Relay not set up. Run `npm run setup`.' }
  if (state === 'missing-wireguard') return { ok: false, message: 'WireGuard is not installed.' }
  if (state === 'up') {
    return peerReachable()
      ? { ok: true, message: 'The relay tunnel was already up.' }
      : { ok: false, message: 'The tunnel is up but the far end does not respond.' }
  }

  console.log(process.platform === 'win32'
    ? '🔐 Bringing up the relay tunnel. Windows will ask for administrator confirmation (UAC).'
    : '🔐 Bringing up the relay tunnel. macOS will ask for your administrator password.')
  try {
    elevate('up')
  } catch {
    return { ok: false, message: 'Could not bring up the tunnel (was authentication cancelled?).' }
  }
  // There is no wg-quick on Windows, so the message does not name the tool.
  if (tunnelState() !== 'up') return { ok: false, message: 'WireGuard finished but the interface does not appear.' }
  return peerReachable()
    ? { ok: true, message: 'Relay tunnel is up.' }
    : { ok: false, message: 'Tunnel is up, but the far end does not respond. Is the VPS alive?' }
}

export function bringDown(): TunnelResult {
  const state = tunnelState()
  if (state !== 'up') return { ok: true, message: 'The relay tunnel was already down.' }
  try {
    elevate('down')
  } catch {
    return { ok: false, message: 'Could not take the tunnel down (was authentication cancelled?).' }
  }
  return { ok: true, message: 'Relay tunnel is down.' }
}
