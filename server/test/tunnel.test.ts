import { describe, it, expect } from 'vitest'
import { addressIsAssigned, interfaceHasAddress, parseConfAddresses, parseConfPrivateKey } from '../src/setup/tunnel.js'

const CONF = `# comment
[Interface]
Address = 10.77.0.2/24
PrivateKey = PRIVATEKEY=

[Peer]
PublicKey = PUBLICKEY=
Endpoint = 1.2.3.4:51820
AllowedIPs = 10.77.0.1/32
PersistentKeepalive = 25
`

describe('parseConfAddresses', () => {
  it('pulls both addresses out and strips the mask', () => {
    expect(parseConfAddresses(CONF)).toEqual({ local: '10.77.0.2', peer: '10.77.0.1' })
  })

  it('tolerates odd whitespace and different casing in the keys', () => {
    const odd = '[Interface]\n   address=10.9.9.2/24\n[Peer]\nALLOWEDIPS  =  10.9.9.1/32\n'
    expect(parseConfAddresses(odd)).toEqual({ local: '10.9.9.2', peer: '10.9.9.1' })
  })

  // With several networks in AllowedIPs only the first matters: it is the VPS's,
  // and the one used for the liveness ping.
  it('takes the first entry when AllowedIPs holds a list', () => {
    const multi = '[Interface]\nAddress = 10.77.0.2/24\n[Peer]\nAllowedIPs = 10.77.0.1/32, 10.77.0.0/24\n'
    expect(parseConfAddresses(multi).peer).toBe('10.77.0.1')
  })

  it('returns null for whatever is missing rather than inventing an address', () => {
    expect(parseConfAddresses('[Interface]\n')).toEqual({ local: null, peer: null })
  })
})

// It exists to derive the public key without asking for privileges: `wg show`
// would do the same but on macOS it needs root to read /var/run/wireguard.
describe('parseConfPrivateKey', () => {
  it('pulls out the private key', () => {
    expect(parseConfPrivateKey(CONF)).toBe('PRIVATEKEY=')
  })

  it('does not confuse PrivateKey with PublicKey', () => {
    expect(parseConfPrivateKey('[Peer]\nPublicKey = PUB=\n')).toBeNull()
  })

  it('null when absent, rather than an empty string that would look like a key', () => {
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

  it('finds the tunnel address whatever the utun number is', () => {
    expect(interfaceHasAddress(IFCONFIG, '10.77.0.2')).toBe(true)
  })

  it('does not find it when the tunnel is down', () => {
    const noTunnel = IFCONFIG.split('utun6')[0]
    expect(interfaceHasAddress(noTunnel, '10.77.0.2')).toBe(false)
  })

  // The reason for the anchor in the regex: without it, looking for .1 would
  // match .10 and the preflight would report a down tunnel as alive.
  it('does not mistake a prefix for the whole address', () => {
    expect(interfaceHasAddress('\tinet 10.77.0.20 netmask 0xffffff00', '10.77.0.2')).toBe(false)
    expect(interfaceHasAddress('\tinet 10.77.0.2 netmask 0xffffff00', '10.77.0.20')).toBe(false)
  })

  it('a dot in the pattern is not a wildcard', () => {
    expect(interfaceHasAddress('\tinet 10.77.0.2', '10x77x0x2')).toBe(false)
  })

  it('answers no when there is no address to look for', () => {
    expect(interfaceHasAddress(IFCONFIG, '')).toBe(false)
  })
})

// On Windows the state comes from the addresses the system itself reports and
// not from `sc query`, because sc.exe translates its labels: on a Spanish
// Windows the line reads `ESTADO : 4  RUNNING`, so looking for "STATE" reported a
// live tunnel as down, and `npm start` tried to reinstall it on every boot.
describe('addressIsAssigned', () => {
  const IFACES = {
    wg0: [{ address: 'fe80::1e4b:2a0f:1' }, { address: '10.77.0.2' }],
    Ethernet: [{ address: '192.168.1.175' }],
  }

  it('finds the tunnel address whatever the adapter is called', () => {
    expect(addressIsAssigned(IFACES, '10.77.0.2')).toBe(true)
  })

  it('does not find it when the tunnel is down', () => {
    expect(addressIsAssigned({ Ethernet: IFACES.Ethernet }, '10.77.0.2')).toBe(false)
  })

  // Same reason as in interfaceHasAddress: .2 must not match .20.
  it('does not mistake a prefix for the whole address', () => {
    expect(addressIsAssigned({ wg0: [{ address: '10.77.0.20' }] }, '10.77.0.2')).toBe(false)
  })

  it('answers no when there is no address to look for', () => {
    expect(addressIsAssigned(IFACES, '')).toBe(false)
  })

  // os.networkInterfaces() declares each entry's value optional.
  it('tolerates an interface with no addresses', () => {
    expect(addressIsAssigned({ wg0: undefined }, '10.77.0.2')).toBe(false)
  })
})
