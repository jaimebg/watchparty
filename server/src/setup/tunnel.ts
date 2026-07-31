// Túnel WireGuard del relevo del plano de datos, en macOS y Windows.
//
// Se engancha a `npm start` en vez de a un servicio de arranque porque el túnel
// solo hace falta mientras hay sesión. Dos decisiones para que no moleste:
//
//   - Solo pide elevación si el túnel NO está ya arriba. Arrancar el servidor
//     dos veces en la misma tarde no vuelve a preguntar.
//   - No se baja al terminar. Un túnel inactivo cuesta un paquete cada 25 s, y
//     bajarlo obligaría a una segunda autenticación por sesión. Para bajarlo a
//     mano: `npm run tunnel:down`.
//
// Sobre la elevación: se pide por el diálogo del sistema (osascript en macOS,
// UAC en Windows) y NO por una regla sudo sin contraseña. En macOS el prefijo de
// Homebrew es escribible por el usuario, así que dar sudo sin contraseña a un
// binario que ese mismo usuario puede reemplazar sería una escalada a root para
// cualquier proceso que corra como él.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { dataDir } from '../config.js'
import type { TunnelState } from './checks.js'

export const IFACE = 'wg0'

/** Direcciones del túnel, sacadas del propio wg0.conf para no fijar la subred aquí. */
export interface TunnelAddresses { local: string | null; peer: string | null }

/**
 * `Address` es la IP de este extremo; la del otro sale de `AllowedIPs`, que en
 * esta topología es exactamente el /32 del VPS. Se leen del fichero en vez de
 * codificarlas para que cambiar de subred no exija tocar este módulo.
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
 * La clave privada del `.conf`, para poder derivar la pública sin privilegios.
 * `wg show <iface> public-key` haría lo mismo, pero en macOS necesita root: lee
 * el socket de control en /var/run/wireguard.
 */
export function parseConfPrivateKey(conf: string): string | null {
  return conf.match(/^\s*PrivateKey\s*=\s*(\S+)/mi)?.[1] ?? null
}

/**
 * El número de `utun` cambia entre arranques, así que la interfaz se reconoce
 * por su dirección y no por su nombre.
 */
export function interfaceHasAddress(ifconfigOutput: string, ip: string): boolean {
  if (!ip) return false
  // Anclado a final de palabra: sin esto, 10.77.0.1 daría positivo con 10.77.0.10.
  return new RegExp(`inet\\s+${ip.replace(/\./g, '\\.')}(?![0-9.])`).test(ifconfigOutput)
}

/** Lo único que hace falta de `os.networkInterfaces()`. */
export type InterfaceAddresses = Record<string, readonly { address: string }[] | undefined>

/**
 * La versión Windows de interfaceHasAddress, preguntándole al sistema en vez de
 * a un comando: `sc query` diría lo mismo, pero traduce sus etiquetas —en un
 * Windows en español imprime `ESTADO : 4  RUNNING`— y buscar «STATE» daba por
 * bajado un túnel que estaba vivo. Aquí no hay texto que interpretar, y de paso
 * se comprueba lo que de verdad importa (que la dirección esté puesta) y no que
 * el servicio exista.
 */
export function addressIsAssigned(ifaces: InterfaceAddresses, ip: string): boolean {
  if (!ip) return false
  return Object.values(ifaces).some(addrs => addrs?.some(a => a.address === ip))
}

// ---------------------------------------------------------------------------
// Rutas por plataforma
// ---------------------------------------------------------------------------

/** Prefijo de Homebrew: Apple Silicon usa /opt/homebrew, Intel /usr/local. */
function brewPrefix(): string | null {
  for (const p of ['/opt/homebrew', '/usr/local']) if (existsSync(join(p, 'bin', 'wg-quick'))) return p
  return null
}

const WINDOWS_WIREGUARD = 'C:\\Program Files\\WireGuard\\wireguard.exe'

/**
 * En macOS el fichero tiene que vivir en una de las rutas que busca wg-quick;
 * en Windows lo pone donde ya vive la config de la app, porque allí lo pasamos a
 * `wireguard.exe` por ruta completa y no hay convención que respetar.
 */
export function confPath(): string {
  if (process.platform === 'win32') return join(dataDir(), 'wireguard', `${IFACE}.conf`)
  const prefix = brewPrefix() ?? '/opt/homebrew'
  return join(prefix, 'etc', 'wireguard', `${IFACE}.conf`)
}

// ---------------------------------------------------------------------------
// Estado
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
 * Una interfaz levantada no implica que el otro extremo esté vivo (VPS caído,
 * red del host cambiada). El ping sí lo prueba, y no necesita privilegios.
 */
export function peerReachable(): boolean {
  const { peer } = addresses()
  if (!peer) return false
  // Windows mide el timeout en ms con -w; macOS con -W, y cuenta con -n/-c.
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
// Levantar y bajar (con elevación)
// ---------------------------------------------------------------------------

function elevateMac(verb: 'up' | 'down'): void {
  const prefix = brewPrefix()
  if (!prefix) throw new Error('WireGuard no está instalado (falta wg-quick)')
  // PATH explícito y bash de brew a la fuerza: wg-quick lleva shebang
  // `env bash` y el bash 3.2 del sistema lo rechaza en su primera comprobación;
  // además necesita encontrar `wg` y `wireguard-go` del mismo prefijo.
  const inner = `PATH=${prefix}/bin:/usr/bin:/bin:/usr/sbin:/sbin ${prefix}/bin/bash ${prefix}/bin/wg-quick ${verb} ${IFACE} 2>&1`
  const script = `do shell script "${inner.replace(/"/g, '\\"')}" with administrator privileges`
  execFileSync('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'ignore', 'inherit'] })
}

function elevateWindows(verb: 'up' | 'down'): void {
  if (!existsSync(WINDOWS_WIREGUARD)) throw new Error('WireGuard para Windows no está instalado')
  // /installtunnelservice registra el túnel como servicio (y así sobrevive al
  // cierre de esta consola); /uninstalltunnelservice lo retira. Ambos exigen
  // administrador, de ahí el -Verb RunAs que dispara el UAC.
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
  if (state === 'unsupported') return { ok: false, message: `Sin soporte de relevo en ${process.platform}.` }
  if (state === 'unconfigured') return { ok: false, message: 'Relevo sin configurar. Ejecuta `npm run setup`.' }
  if (state === 'missing-wireguard') return { ok: false, message: 'WireGuard no está instalado.' }
  if (state === 'up') {
    return peerReachable()
      ? { ok: true, message: 'El túnel del relevo ya estaba activo.' }
      : { ok: false, message: 'El túnel está levantado pero el otro extremo no responde.' }
  }

  console.log(process.platform === 'win32'
    ? '🔐 Levantando el túnel del relevo — Windows va a pedirte confirmación de administrador (UAC).'
    : '🔐 Levantando el túnel del relevo — macOS va a pedirte tu contraseña de administrador.')
  try {
    elevate('up')
  } catch {
    return { ok: false, message: 'No se pudo levantar el túnel (¿se canceló la autenticación?).' }
  }
  // En Windows no hay wg-quick, así que el mensaje no nombra la herramienta.
  if (tunnelState() !== 'up') return { ok: false, message: 'WireGuard terminó pero la interfaz no aparece.' }
  return peerReachable()
    ? { ok: true, message: 'Túnel del relevo activo.' }
    : { ok: false, message: 'Túnel levantado, pero el otro extremo no responde. ¿Está vivo el VPS?' }
}

export function bringDown(): TunnelResult {
  const state = tunnelState()
  if (state !== 'up') return { ok: true, message: 'El túnel del relevo ya estaba bajado.' }
  try {
    elevate('down')
  } catch {
    return { ok: false, message: 'No se pudo bajar el túnel (¿se canceló la autenticación?).' }
  }
  return { ok: true, message: 'Túnel del relevo bajado.' }
}
