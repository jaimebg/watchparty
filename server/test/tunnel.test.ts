import { describe, it, expect } from 'vitest'
import { interfaceHasAddress, parseConfAddresses, parseConfPrivateKey, windowsServiceRunning } from '../src/setup/tunnel.js'

const CONF = `# comentario
[Interface]
Address = 10.77.0.2/24
PrivateKey = SECRETA=

[Peer]
PublicKey = PUBLICA=
Endpoint = 1.2.3.4:51820
AllowedIPs = 10.77.0.1/32
PersistentKeepalive = 25
`

describe('parseConfAddresses', () => {
  it('saca las dos direcciones y les quita la máscara', () => {
    expect(parseConfAddresses(CONF)).toEqual({ local: '10.77.0.2', peer: '10.77.0.1' })
  })

  it('tolera espacios raros y mayúsculas distintas en las claves', () => {
    const raro = '[Interface]\n   address=10.9.9.2/24\n[Peer]\nALLOWEDIPS  =  10.9.9.1/32\n'
    expect(parseConfAddresses(raro)).toEqual({ local: '10.9.9.2', peer: '10.9.9.1' })
  })

  // Con varias redes en AllowedIPs solo interesa la primera: es la del VPS, y es
  // la que se usa para el ping de vida.
  it('con una lista en AllowedIPs se queda con la primera', () => {
    const multi = '[Interface]\nAddress = 10.77.0.2/24\n[Peer]\nAllowedIPs = 10.77.0.1/32, 10.77.0.0/24\n'
    expect(parseConfAddresses(multi).peer).toBe('10.77.0.1')
  })

  it('devuelve null en lo que falte en vez de inventarse una dirección', () => {
    expect(parseConfAddresses('[Interface]\n')).toEqual({ local: null, peer: null })
  })
})

// Existe para derivar la clave pública sin pedir privilegios: `wg show` haría lo
// mismo pero en macOS necesita root para leer /var/run/wireguard.
describe('parseConfPrivateKey', () => {
  it('saca la clave privada', () => {
    expect(parseConfPrivateKey(CONF)).toBe('SECRETA=')
  })

  it('no confunde PrivateKey con PublicKey', () => {
    expect(parseConfPrivateKey('[Peer]\nPublicKey = PUB=\n')).toBeNull()
  })

  it('null cuando no está, en vez de una cadena vacía que pareciera una clave', () => {
    expect(parseConfPrivateKey('[Interface]\nAddress = 10.0.0.1/24\n')).toBeNull()
  })
})

describe('interfaceHasAddress', () => {
  const IFCONFIG = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
	inet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
	inet 192.168.1.12 netmask 0xffffff00 broadcast 192.168.1.255
utun6: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1420
	inet 10.77.0.2 --> 10.77.0.2 netmask 0xffffff00
`

  it('encuentra la dirección del túnel sea cual sea el número de utun', () => {
    expect(interfaceHasAddress(IFCONFIG, '10.77.0.2')).toBe(true)
  })

  it('no la encuentra cuando el túnel está bajado', () => {
    const sinTunel = IFCONFIG.split('utun6')[0]
    expect(interfaceHasAddress(sinTunel, '10.77.0.2')).toBe(false)
  })

  // La razón del anclaje en el regex: sin él, buscar .1 daría positivo con .10 y
  // el preflight daría por vivo un túnel bajado.
  it('no confunde un prefijo con la dirección entera', () => {
    expect(interfaceHasAddress('\tinet 10.77.0.20 netmask 0xffffff00', '10.77.0.2')).toBe(false)
    expect(interfaceHasAddress('\tinet 10.77.0.2 netmask 0xffffff00', '10.77.0.20')).toBe(false)
  })

  it('un punto del patrón no hace de comodín', () => {
    expect(interfaceHasAddress('\tinet 10.77.0.2', '10x77x0x2')).toBe(false)
  })

  it('sin dirección que buscar responde que no', () => {
    expect(interfaceHasAddress(IFCONFIG, '')).toBe(false)
  })
})

describe('windowsServiceRunning', () => {
  it('reconoce el servicio del túnel en marcha', () => {
    expect(windowsServiceRunning('        STATE              : 4  RUNNING')).toBe(true)
  })

  it('parado o inexistente cuenta como bajado', () => {
    expect(windowsServiceRunning('        STATE              : 1  STOPPED')).toBe(false)
    expect(windowsServiceRunning('El servicio especificado no existe.')).toBe(false)
    expect(windowsServiceRunning('')).toBe(false)
  })
})
