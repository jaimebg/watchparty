// `npm run setup` — puesta a punto de una máquina nueva, Windows incluido.
//
// Hace todo lo que se puede hacer sin credenciales ajenas: genera el par de
// claves WireGuard de esta máquina y escribe su wg0.conf. Lo que no puede hacer
// (autorizar la clave en el VPS, crear el registro DNS) lo imprime como comandos
// listos para copiar, con los valores ya sustituidos.
//
// Es idempotente: si el túnel ya está configurado no regenera nada, porque
// hacerlo invalidaría la clave que el VPS ya tiene autorizada.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig } from '../config.js'
import { confPath, IFACE, parseConfPrivateKey, tunnelState } from './tunnel.js'

const config = loadConfig()
const line = (s = '') => console.log(s)

/** `wg` vive en el prefijo de brew en macOS y junto a wireguard.exe en Windows. */
function wgBinary(): string | null {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\WireGuard\\wg.exe']
    : ['/opt/homebrew/bin/wg', '/usr/local/bin/wg']
  return candidates.find(existsSync) ?? null
}

function installHint(): string {
  if (process.platform === 'win32') return 'Descarga e instala WireGuard: https://www.wireguard.com/install/'
  if (process.platform === 'darwin') return 'Instálalo con:  brew install wireguard-tools'
  return 'Instálalo con el gestor de paquetes de tu distribución (paquete `wireguard-tools`).'
}

line()
line('🎬 jbg-watchparty — puesta a punto')
line()

// ---------------------------------------------------------------------------
// 1. El relevo: ¿hace falta?
// ---------------------------------------------------------------------------
const relayWanted = Boolean(config.streamBaseUrl || config.relayEndpoint)

if (!relayWanted) {
  line('ℹ️  Relevo del plano de datos: no configurado, y no hace falta para uso en')
  line('   red local ni con el túnel de Cloudflare. Si lo quieres, rellena')
  line('   relayEndpoint / relayPeerPublicKey / relayPeerIp y streamBaseUrl en')
  line('   config.defaults.json y vuelve a ejecutar `npm run setup`.')
  line()
  line('▶️  Nada más que hacer. Lanza `npm start`.')
  line()
  process.exit(0)
}

const missing = [
  !config.relayEndpoint && 'relayEndpoint',
  !config.relayPeerPublicKey && 'relayPeerPublicKey',
  !config.relayPeerIp && 'relayPeerIp',
  !config.relayLocalIp && 'relayLocalIp',
].filter(Boolean)

if (missing.length > 0) {
  line(`❌ Falta configuración del relevo: ${missing.join(', ')}`)
  line('   Rellénalos en config.defaults.json (viajan con el repo: no son secretos).')
  line()
  process.exit(1)
}

const wg = wgBinary()
if (!wg) {
  line('❌ WireGuard no está instalado en esta máquina.')
  line(`   ${installHint()}`)
  line('   Después, vuelve a ejecutar `npm run setup`.')
  line()
  process.exit(1)
}
line('✅ WireGuard instalado')

// ---------------------------------------------------------------------------
// 2. Claves y wg0.conf de esta máquina
// ---------------------------------------------------------------------------
const path = confPath()
let publicKey: string

if (tunnelState() !== 'unconfigured') {
  // Regenerar aquí dejaría al VPS autorizando una clave que ya no usamos, y el
  // túnel se caería sin más explicación que un handshake que nunca llega.
  line(`✅ Túnel ya configurado en ${path} (no se toca)`)
  // Se deriva de la clave privada del fichero y no con `wg show`: eso último
  // necesita root en macOS (lee el socket de control de /var/run/wireguard),
  // y aquí no hace falta pedir privilegios para nada.
  const priv = parseConfPrivateKey(readFileSync(path, 'utf8'))
  publicKey = priv
    ? execFileSync(wg, ['pubkey'], { input: priv, encoding: 'utf8' }).trim()
    : '(no se pudo leer la clave del .conf)'
} else {
  const privateKey = execFileSync(wg, ['genkey'], { encoding: 'utf8' }).trim()
  publicKey = execFileSync(wg, ['pubkey'], { input: privateKey, encoding: 'utf8' }).trim()

  const conf = `# Extremo local del relevo de jbg-watchparty. Generado por \`npm run setup\`.
[Interface]
Address = ${config.relayLocalIp}/24
PrivateKey = ${privateKey}

[Peer]
PublicKey = ${config.relayPeerPublicKey}
Endpoint = ${config.relayEndpoint}
# SOLO el /32 del VPS. Esto no es una VPN de salida: el resto del trafico de
# esta maquina sigue por su ruta de siempre.
AllowedIPs = ${config.relayPeerIp}/32
# Imprescindible: este host esta detras de NAT y es el VPS quien INICIA las
# conexiones hacia aqui. Sin keepalive el mapeo del router caduca y el VPS deja
# de alcanzarnos a mitad de pelicula.
PersistentKeepalive = 25
`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, conf, { mode: 0o600 })
  line(`✅ Claves generadas y configuración escrita en ${path}`)
}

// ---------------------------------------------------------------------------
// 3. Lo que hay que hacer fuera de esta máquina
// ---------------------------------------------------------------------------
const [host] = String(config.relayEndpoint).split(':')

line()
line('── Queda un paso manual, en el VPS ──────────────────────────────')
line()
line('   Autoriza la clave de esta máquina (reemplaza el peer anterior: solo')
line('   sirve un host a la vez, y el reverse_proxy del VPS apunta a una IP fija):')
line()
line(`   ssh ubuntu@${host} "sudo wg set ${IFACE} peer ${publicKey} allowed-ips ${config.relayLocalIp}/32 && sudo wg-quick save ${IFACE}"`)
line()
if (config.streamBaseUrl) {
  const name = config.streamBaseUrl.replace(/^https?:\/\//, '')
  line(`   Y comprueba que ${name} resuelve a ${host} con el proxy DESACTIVADO`)
  line('   (nube gris en Cloudflare). En naranja el vídeo vuelve a pasar por el CDN.')
  line()
}
line('────────────────────────────────────────────────────────────────')
line()
line('▶️  Hecho eso, `npm start` levanta el túnel solo y comprueba el resto.')
line()
