import { describe, it, expect } from 'vitest'
import { evaluate, formatFinding, worstLevel, type Facts, type Finding } from '../src/setup/checks.js'

// Entorno sano: cada test parte de aquí y rompe UNA cosa, para que el hallazgo
// que se comprueba no pueda venir de otro sitio.
const healthy: Facts = {
  platform: 'darwin',
  nodeMajor: 22,
  ffmpegOk: true,
  ffprobeOk: true,
  webBuilt: true,
  mediaFolders: ['/pelis'],
  mediaFoldersPresent: ['/pelis'],
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
  it('un entorno sano no produce ni un aviso', () => {
    expect(problems(of({}))).toEqual([])
    expect(worstLevel(of({}))).toBe('ok')
  })

  it('Node por debajo del mínimo es fatal', () => {
    const fs = of({ nodeMajor: 18 })
    expect(worstLevel(fs)).toBe('fatal')
    expect(titles(fs)).toContain('Node 18 is too old')
  })

  it('sin ffmpeg o sin ffprobe es fatal, y dice cuál falta', () => {
    expect(worstLevel(of({ ffmpegOk: false }))).toBe('fatal')
    expect(titles(of({ ffmpegOk: false }))).toContain('Missing ffmpeg')
    expect(titles(of({ ffprobeOk: false }))).toContain('Missing ffprobe')
    expect(titles(of({ ffmpegOk: false, ffprobeOk: false }))).toContain('Missing ffmpeg and ffprobe')
  })

  // El fallo nativo es un EADDRINUSE sin contexto, y la causa casi siempre es
  // una segunda instancia: merece pararlo antes con un mensaje que lo diga.
  it('el puerto ocupado es fatal', () => {
    const fs = of({ portFree: false })
    expect(worstLevel(fs)).toBe('fatal')
    expect(titles(fs)).toContain('Port 8400 is taken')
  })

  it('la web sin compilar solo avisa (npm start la compila)', () => {
    expect(worstLevel(of({ webBuilt: false }))).toBe('warn')
  })

  it('avisa de la biblioteca vacía y de las carpetas que ya no existen', () => {
    expect(titles(of({ mediaFolders: [], mediaFoldersPresent: [] })))
      .toContain('No media folders configured')
    const gone = of({ mediaFolders: ['/pelis', '/usb'], mediaFoldersPresent: ['/pelis'] })
    expect(titles(gone)).toContain('1 media folder does not exist')
    expect(problems(gone)[0].detail).toBe('/usb')
  })

  it('avisa si tunnelToken y tunnelUrl no van en pareja', () => {
    expect(titles(of({ tunnelUrl: null }))).toContain('Cloudflare tunnel config incomplete')
    expect(titles(of({ tunnelToken: null }))).toContain('Cloudflare tunnel config incomplete')
    // Los dos ausentes es válido: significa Quick Tunnel.
    expect(problems(of({ tunnelToken: null, tunnelUrl: null }))).toEqual([])
  })
})

describe('evaluate — relevo', () => {
  const withRelay = (extra: Partial<Facts>) => of({ streamBaseUrl: 'https://stream.example', ...extra })

  // Sin streamBaseUrl no hay relevo que vigilar: no se molesta al usuario.
  it('callado cuando no hay relevo configurado', () => {
    expect(problems(of({ tunnel: 'down' }))).toEqual([])
    expect(problems(of({ tunnel: 'missing-wireguard' }))).toEqual([])
  })

  // Pero un túnel levantado sin usar sí es raro y vale decirlo: gasta y no sirve.
  it('avisa del túnel levantado que nadie usa', () => {
    expect(titles(of({ tunnel: 'up' }))).toContain('Relay tunnel up but unused')
  })

  it('el relevo sano es un OK y nada más', () => {
    const fs = withRelay({ tunnel: 'up', tunnelPeerReachable: true })
    expect(problems(fs)).toEqual([])
    expect(titles(fs)).toContain('Relay up toward https://stream.example')
  })

  // La distinción que importa: la interfaz puede existir con el VPS muerto, y
  // eso se ve igual que "todo bien" si solo se mira el nombre de la interfaz.
  it('distingue interfaz levantada de otro extremo alcanzable', () => {
    const fs = withRelay({ tunnel: 'up', tunnelPeerReachable: false })
    expect(worstLevel(fs)).toBe('warn')
    expect(titles(fs)).toContain('the far end does not respond')
  })

  it('el túnel caído avisa pero nunca impide arrancar', () => {
    // El panel y la LAN siguen funcionando: convertirlo en fatal dejaría al host
    // sin poder ver nada por un problema que solo afecta a los invitados.
    const fs = withRelay({ tunnel: 'down' })
    expect(worstLevel(fs)).toBe('warn')
  })

  it('da la instrucción de instalación propia de cada plataforma', () => {
    const mac = problems(withRelay({ tunnel: 'missing-wireguard', platform: 'darwin' }))
    expect(mac[0].fix).toContain('brew install wireguard-tools')
    const win = problems(withRelay({ tunnel: 'missing-wireguard', platform: 'win32' }))
    expect(win[0].fix).toContain('wireguard.com/install')
  })

  it('manda a `npm run setup` cuando falta la config local del túnel', () => {
    expect(problems(withRelay({ tunnel: 'unconfigured' }))[0].fix).toContain('npm run setup')
  })

  it('avisa en plataformas donde no sabemos levantar el túnel', () => {
    const fs = withRelay({ platform: 'linux', tunnel: 'unsupported' })
    expect(titles(fs)).toContain('Relay not supported on this platform')
  })
})

describe('formatFinding', () => {
  it('marca el nivel con un icono y sangra detalle y arreglo', () => {
    const out = formatFinding({ level: 'fatal', title: 'Roto', detail: 'porque sí', fix: 'arréglalo' })
    expect(out.split('\n')[0]).toBe('❌ Roto')
    expect(out).toContain('     porque sí')
    expect(out).toContain('     → arréglalo')
  })

  it('un OK sin detalle es una sola línea', () => {
    expect(formatFinding({ level: 'ok', title: 'Node 22' })).toBe('✅ Node 22')
  })
})

describe('worstLevel', () => {
  it('fatal gana a warn, y warn a ok', () => {
    expect(worstLevel([{ level: 'ok', title: 'a' }, { level: 'warn', title: 'b' }])).toBe('warn')
    expect(worstLevel([{ level: 'warn', title: 'a' }, { level: 'fatal', title: 'b' }])).toBe('fatal')
    expect(worstLevel([])).toBe('ok')
  })
})
