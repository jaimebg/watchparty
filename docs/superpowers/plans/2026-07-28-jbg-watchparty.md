# jbg-watchparty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Servidor local (Windows/macOS) para ver vídeo sincronizado en grupo vía navegador, con HLS multi-audio en directo, chat, reacciones y GIFs.

**Architecture:** Monorepo npm workspaces. `server/` = Fastify + WebSocket que orquesta ffmpeg (HLS en directo con renditions de audio y WebVTT) y cloudflared (túnel público). `web/` = React + Vite + hls.js, mismo cliente para host (localhost, cookie admin) e invitados (URL del túnel). El servidor es autoridad única del estado de reproducción; los clientes corrigen deriva localmente.

**Tech Stack:** Node ≥ 20, TypeScript (strict, ESM), Fastify 4, @fastify/websocket, @fastify/cookie, ffmpeg-static, ffprobe-static, vitest, React 18, Vite 5, hls.js.

**Spec:** `docs/superpowers/specs/2026-07-28-jbg-watchparty-design.md` — leerlo antes de empezar.

## Global Constraints

- Node ≥ 20. ESM en todos los paquetes (`"type": "module"`). TypeScript `strict: true`.
- Segmentos HLS: fMP4, duración objetivo **4 s**. Variante `0` = vídeo; variantes `1..N` = pistas de audio (en orden del archivo). Nombres: `seg_%v_%05d.m4s`, `init_%v.mp4`.
- Directorio de datos: `~/Library/Application Support/jbg-watchparty` (macOS) / `%APPDATA%\jbg-watchparty` (Windows). Override con env `JBG_DATA_DIR` (los tests lo usan siempre).
- Puerto por defecto: **8400**.
- Extensiones de vídeo escaneadas: `.mkv .mp4 .avi .m4v .webm`.
- Klipy: `GET https://api.klipy.com/api/v1/{API_KEY}/gifs/search?q=&page=&per_page=` → `{ result: boolean, data: { data: Item[], current_page, per_page, has_next } }`.
- Tests con vitest (`npx vitest run` dentro de cada workspace). Los tests de integración de ffmpeg usan fixtures sintéticos generados en el propio test — nunca archivos reales del usuario.
- Commits frecuentes, mensajes `feat:|test:|chore:|fix:`.
- Subtítulos de imagen (PGS/VobSub), persistencia, TMDB, empaquetado nativo: **fuera de alcance** (ver spec).

---

### Task 1: Monorepo + Fastify con /health

**Files:**
- Create: `package.json`, `.gitignore`, `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/src/app.ts`, `server/src/index.ts`
- Test: `server/test/app.test.ts`

**Interfaces:**
- Produces: `buildApp(deps: AppDeps): Promise<FastifyInstance>` en `server/src/app.ts`. `AppDeps` empieza vacío (`{}`) y las tasks siguientes le añaden campos. Ruta `GET /health` → `{ ok: true }`.

- [ ] **Step 1: Root package.json y .gitignore**

`package.json`:
```json
{
  "name": "jbg-watchparty",
  "private": true,
  "type": "module",
  "workspaces": ["server", "web"],
  "scripts": {
    "start": "npm run build -w web && npm run start -w server",
    "test": "npm run test -w server && npm run test -w web"
  }
}
```

`.gitignore`:
```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 2: server/package.json y tsconfig**

`server/package.json`:
```json
{
  "name": "@jbg/server",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fastify/cookie": "^9.3.1",
    "@fastify/static": "^7.0.4",
    "@fastify/websocket": "^10.0.1",
    "fastify": "^4.28.1",
    "ffmpeg-static": "^5.2.0",
    "ffprobe-static": "^3.1.0"
  },
  "devDependencies": {
    "tsx": "^4.16.2",
    "typescript": "^5.5.3",
    "vitest": "^2.0.3",
    "ws": "^8.18.0",
    "@types/ws": "^8.5.10",
    "@types/node": "^20.14.10"
  }
}
```

`server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 120_000 } })
```

- [ ] **Step 3: Failing test**

`server/test/app.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildApp } from '../src/app.js'

describe('app', () => {
  it('responds to /health', async () => {
    const app = await buildApp({})
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    await app.close()
  })
})
```

- [ ] **Step 4: Run `npm install` en la raíz, luego `npx vitest run` en `server/`** — Expected: FAIL (no existe `src/app.ts`).

- [ ] **Step 5: Implementación**

`server/src/app.ts`:
```ts
import Fastify, { FastifyInstance } from 'fastify'

export interface AppDeps {}

export async function buildApp(_deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.get('/health', async () => ({ ok: true }))
  return app
}
```

`server/src/index.ts`:
```ts
import { buildApp } from './app.js'

const app = await buildApp({})
await app.listen({ port: 8400, host: '0.0.0.0' })
console.log('jbg-watchparty en http://localhost:8400')
```

- [ ] **Step 6: `npx vitest run` en server/** — Expected: PASS. `npx tsc --noEmit` limpio.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: monorepo scaffold with fastify health endpoint"`

---

### Task 2: Config y directorio de datos

**Files:**
- Create: `server/src/config.ts`
- Test: `server/test/config.test.ts`

**Interfaces:**
- Produces:
  - `dataDir(): string` — respeta `JBG_DATA_DIR`; si no, ruta por plataforma (Global Constraints).
  - `interface Config { mediaFolders: string[]; klipyApiKey: string | null; port: number; hostName: string; cacheLimitGB: number }`
  - `loadConfig(): Config` (crea el archivo con defaults si no existe), `saveConfig(c: Config): void`. Archivo: `<dataDir>/config.json`. Defaults: `{ mediaFolders: [], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 }`.
  - `cacheDir(): string` — `<dataDir>/cache`.

- [ ] **Step 1: Failing test**

`server/test/config.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataDir, loadConfig, saveConfig, cacheDir } from '../src/config.js'

describe('config', () => {
  beforeEach(() => { process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'jbg-')) })

  it('dataDir respects JBG_DATA_DIR', () => {
    expect(dataDir()).toBe(process.env.JBG_DATA_DIR)
    expect(cacheDir()).toBe(join(dataDir(), 'cache'))
  })

  it('loadConfig creates defaults and roundtrips', () => {
    const c = loadConfig()
    expect(c).toEqual({ mediaFolders: [], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 })
    saveConfig({ ...c, mediaFolders: ['/pelis'] })
    expect(loadConfig().mediaFolders).toEqual(['/pelis'])
  })
})
```

- [ ] **Step 2: Run** — Expected: FAIL (módulo no existe).
- [ ] **Step 3: Implementación**

`server/src/config.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  mediaFolders: string[]
  klipyApiKey: string | null
  port: number
  hostName: string
  cacheLimitGB: number
}

const DEFAULTS: Config = { mediaFolders: [], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 }

export function dataDir(): string {
  if (process.env.JBG_DATA_DIR) return process.env.JBG_DATA_DIR
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'jbg-watchparty')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'jbg-watchparty')
  return join(homedir(), '.local', 'share', 'jbg-watchparty')
}

export const cacheDir = () => join(dataDir(), 'cache')
const configPath = () => join(dataDir(), 'config.json')

export function loadConfig(): Config {
  mkdirSync(dataDir(), { recursive: true })
  if (!existsSync(configPath())) writeFileSync(configPath(), JSON.stringify(DEFAULTS, null, 2))
  return { ...DEFAULTS, ...JSON.parse(readFileSync(configPath(), 'utf8')) }
}

export function saveConfig(c: Config): void {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(c, null, 2))
}
```

- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: config file and platform data dir"`

---

### Task 3: Limpieza de nombres de archivo

**Files:**
- Create: `server/src/library/nameClean.ts`
- Test: `server/test/nameClean.test.ts`

**Interfaces:**
- Produces: `cleanName(filename: string): string` — quita extensión, tags de calidad/códec/grupo, puntos/guiones bajos → espacios. Conserva marcadores `S01E02`.

- [ ] **Step 1: Failing test (table-driven)**

`server/test/nameClean.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { cleanName } from '../src/library/nameClean.js'

describe('cleanName', () => {
  it.each([
    ['La.Peli.2023.1080p.BluRay.x265-GRUPO.mkv', 'La Peli 2023'],
    ['Serie.S01E02.720p.WEB-DL.AAC.mp4', 'Serie S01E02'],
    ['Otra_Peli_[2160p]_(HDR10).mkv', 'Otra Peli'],
    ['simple.mp4', 'simple'],
    ['Peli.Con.Puntos.mkv', 'Peli Con Puntos'],
  ])('%s -> %s', (input, expected) => {
    expect(cleanName(input)).toBe(expected)
  })
})
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implementación**

`server/src/library/nameClean.ts`:
```ts
const TAGS = /\b(2160p|1080p|720p|480p|4k|uhd|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|hdtv|dvdrip|x264|x265|h264|h265|hevc|avc|aac|ac3|eac3|dts|ddp?[57]\.1|atmos|10bit|hdr10\+?|hdr|dv|remux|proper|repack|extended|unrated|multi|vose|castellano|latino|dual)\b/gi

export function cleanName(filename: string): string {
  let s = filename.replace(/\.[^.]+$/, '')
  s = s.replace(/[._]/g, ' ')
  s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
  s = s.replace(TAGS, ' ')
  s = s.replace(/-\s*[A-Za-z0-9]+\s*$/, ' ')
  return s.replace(/\s{2,}/g, ' ').trim()
}
```

Nota: si un caso de la tabla falla por orden de reglas (p. ej. el año dentro de paréntesis), ajusta el test o la regex razonándolo — la tabla es el contrato.

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: filename cleanup for library titles"`

---

### Task 4: Escáner de biblioteca

**Files:**
- Create: `server/src/library/scanner.ts`
- Test: `server/test/scanner.test.ts`

**Interfaces:**
- Consumes: `cleanName` (Task 3).
- Produces:
  - `interface LibraryItem { id: string; path: string; title: string; folderName: string; srtFiles: string[] }` — `id` = sha1 hex del path absoluto.
  - `scanLibrary(folders: string[]): Promise<LibraryItem[]>` — recursivo, solo extensiones de vídeo (Global Constraints), `srtFiles` = `.srt` en el mismo directorio cuyo nombre empieza por el nombre base del vídeo. Ordenado por `folderName` y luego `path`. Carpetas inexistentes se ignoran sin error.

- [ ] **Step 1: Failing test**

`server/test/scanner.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanLibrary } from '../src/library/scanner.js'

describe('scanLibrary', () => {
  it('finds videos recursively with adjacent srt, skips other files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-'))
    mkdirSync(join(root, 'SerieX', 'Season1'), { recursive: true })
    writeFileSync(join(root, 'Peli.2020.1080p.mkv'), '')
    writeFileSync(join(root, 'Peli.2020.1080p.es.srt'), '')
    writeFileSync(join(root, 'notas.txt'), '')
    writeFileSync(join(root, 'SerieX', 'Season1', 'SerieX.S01E01.mp4'), '')
    const items = await scanLibrary([root, '/no/existe'])
    expect(items).toHaveLength(2)
    const peli = items.find(i => i.path.endsWith('.mkv'))!
    expect(peli.title).toBe('Peli 2020')
    expect(peli.srtFiles).toHaveLength(1)
    const ep = items.find(i => i.path.endsWith('.mp4'))!
    expect(ep.folderName).toBe('Season1')
    expect(ep.id).toMatch(/^[a-f0-9]{40}$/)
  })
})
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implementación**

`server/src/library/scanner.ts`:
```ts
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { cleanName } from './nameClean.js'

export interface LibraryItem { id: string; path: string; title: string; folderName: string; srtFiles: string[] }

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.webm'])

async function walk(dir: string, out: string[]): Promise<void> {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (VIDEO_EXT.has(extname(e.name).toLowerCase())) out.push(p)
  }
}

export async function scanLibrary(folders: string[]): Promise<LibraryItem[]> {
  const files: string[] = []
  for (const f of folders) await walk(resolve(f), files)
  const items: LibraryItem[] = []
  for (const path of files) {
    const dir = dirname(path)
    const base = basename(path, extname(path))
    const siblings = (await readdir(dir)).filter(n => n.endsWith('.srt') && n.startsWith(base))
    items.push({
      id: createHash('sha1').update(path).digest('hex'),
      path,
      title: cleanName(basename(path)),
      folderName: basename(dir),
      srtFiles: siblings.map(n => join(dir, n)),
    })
  }
  return items.sort((a, b) => a.folderName.localeCompare(b.folderName) || a.path.localeCompare(b.path))
}
```

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: media library scanner"`

---

### Task 5: ffprobe — pistas y keyframes (+ fixture sintético)

**Files:**
- Create: `server/src/media/probe.ts`, `server/test/support/run.ts`, `server/test/support/fixture.ts`
- Test: `server/test/probe.test.ts`

**Interfaces:**
- Produces:
  - `interface AudioTrack { index: number; codec: string; lang: string; label: string; channels: number }` (`index` = posición entre las pistas de audio: `0:a:index`; `lang` ISO del contenedor o `'und'`; `label` = título de pista o `Pista ${index+1}`)
  - `interface SubTrack { index: number; codec: string; lang: string; label: string; textBased: boolean }` (`textBased` = codec ∈ {subrip, ass, ssa, webvtt, mov_text})
  - `interface MediaInfo { durationSec: number; videoCodec: string; width: number; height: number; audio: AudioTrack[]; subs: SubTrack[] }`
  - `probeFile(path: string): Promise<MediaInfo>`
  - `extractKeyframes(path: string): Promise<number[]>` — segundos (pts) de paquetes de vídeo con flag `K`, ordenados.
  - Test support: `run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }>` (rechaza si exit ≠ 0) y `makeFixtureMkv(dir: string, opts?: { seconds?: number; withSubs?: boolean }): Promise<string>` — MKV sintético: testsrc2 320x180 H.264 (`-g 48`), 2 audios sine (spa/eng), sub SRT embebido opcional.

- [ ] **Step 1: Test support**

`server/test/support/run.ts`:
```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const pExecFile = promisify(execFile)

export async function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return pExecFile(bin, args, { maxBuffer: 64 * 1024 * 1024 })
}
```

`server/test/support/fixture.ts`:
```ts
import ffmpegPath from 'ffmpeg-static'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './run.js'

const SRT = '1\n00:00:01,000 --> 00:00:03,000\nHola fixture\n\n2\n00:00:05,000 --> 00:00:07,000\nSegunda línea\n'

export async function makeFixtureMkv(dir: string, opts: { seconds?: number; withSubs?: boolean } = {}): Promise<string> {
  const { seconds = 10, withSubs = true } = opts
  const out = join(dir, 'fixture.mkv')
  const srt = join(dir, 'fixture-src.srt')
  const args = ['-y',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=24:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=880:duration=${seconds}`,
  ]
  if (withSubs) { writeFileSync(srt, SRT); args.push('-i', srt) }
  args.push('-map', '0:v', '-map', '1:a', '-map', '2:a')
  if (withSubs) args.push('-map', '3:s')
  args.push(
    '-metadata:s:a:0', 'language=spa', '-metadata:s:a:1', 'language=eng',
    '-c:v', 'libx264', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
  )
  await run(ffmpegPath as string, args)
  return out
}
```

- [ ] **Step 2: Failing test**

`server/test/probe.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureMkv } from './support/fixture.js'
import { probeFile, extractKeyframes } from '../src/media/probe.js'

let fixture: string
beforeAll(async () => { fixture = await makeFixtureMkv(mkdtempSync(join(tmpdir(), 'probe-'))) })

describe('probeFile', () => {
  it('reads duration, video codec and track lists', async () => {
    const info = await probeFile(fixture)
    expect(info.durationSec).toBeGreaterThan(9)
    expect(info.videoCodec).toBe('h264')
    expect(info.audio).toHaveLength(2)
    expect(info.audio[0]).toMatchObject({ index: 0, lang: 'spa', channels: 1 })
    expect(info.audio[1].lang).toBe('eng')
    expect(info.subs).toHaveLength(1)
    expect(info.subs[0].textBased).toBe(true)
  })
})

describe('extractKeyframes', () => {
  it('returns sorted keyframe times starting near 0', async () => {
    const kf = await extractKeyframes(fixture)
    expect(kf.length).toBeGreaterThanOrEqual(4)
    expect(kf[0]).toBeLessThan(0.5)
    expect([...kf].sort((a, b) => a - b)).toEqual(kf)
  })
})
```

- [ ] **Step 3: Run** — Expected: FAIL (módulo probe no existe). El fixture sí debe generarse — si falla la generación, arregla el fixture antes de seguir.

- [ ] **Step 4: Implementación**

`server/src/media/probe.ts`:
```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffprobeStatic from 'ffprobe-static'

const pExecFile = promisify(execFile)
const FFPROBE = ffprobeStatic.path

export interface AudioTrack { index: number; codec: string; lang: string; label: string; channels: number }
export interface SubTrack { index: number; codec: string; lang: string; label: string; textBased: boolean }
export interface MediaInfo { durationSec: number; videoCodec: string; width: number; height: number; audio: AudioTrack[]; subs: SubTrack[] }

const TEXT_SUB_CODECS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text'])

export async function probeFile(path: string): Promise<MediaInfo> {
  const { stdout } = await pExecFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
  const json = JSON.parse(stdout)
  const streams: any[] = json.streams ?? []
  const video = streams.find(s => s.codec_type === 'video')
  if (!video) throw new Error(`Sin pista de vídeo: ${path}`)
  const audioStreams = streams.filter(s => s.codec_type === 'audio')
  const subStreams = streams.filter(s => s.codec_type === 'subtitle')
  return {
    durationSec: Number(json.format?.duration ?? 0),
    videoCodec: video.codec_name,
    width: video.width, height: video.height,
    audio: audioStreams.map((s, i) => ({
      index: i, codec: s.codec_name, lang: s.tags?.language ?? 'und',
      label: s.tags?.title ?? `Pista ${i + 1}`, channels: s.channels ?? 2,
    })),
    subs: subStreams.map((s, i) => ({
      index: i, codec: s.codec_name, lang: s.tags?.language ?? 'und',
      label: s.tags?.title ?? `Subtítulo ${i + 1}`, textBased: TEXT_SUB_CODECS.has(s.codec_name),
    })),
  }
}

export async function extractKeyframes(path: string): Promise<number[]> {
  const { stdout } = await pExecFile(FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path],
    { maxBuffer: 256 * 1024 * 1024 })
  const times: number[] = []
  for (const line of stdout.split('\n')) {
    const [pts, flags] = line.split(',')
    if (flags?.includes('K') && pts !== 'N/A' && pts) times.push(Number(pts))
  }
  return times.sort((a, b) => a - b)
}
```

- [ ] **Step 5: Run** — Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -am "feat: ffprobe wrapper with track and keyframe extraction"`

---

### Task 6: Planner — segmentos y playlists (puro)

**Files:**
- Create: `server/src/media/planner.ts`
- Test: `server/test/planner.test.ts`

**Interfaces:**
- Produces:
  - `interface Segment { index: number; start: number; duration: number }`
  - `planSegments(durationSec: number, keyframes: number[] | null, target?: number): Segment[]` — con keyframes (modo copy): corta en el primer keyframe ≥ 4 s desde el corte anterior; sin keyframes (transcode): cortes uniformes cada 4 s. Cubre `[0, durationSec)` sin huecos.
  - `segmentForTime(segments: Segment[], t: number): number`
  - `buildMasterPlaylist(audio: AudioTrack[]): string` — `#EXT-X-MEDIA` por pista (GROUP-ID `"aud"`, URI `audio_{index+1}.m3u8`, primera DEFAULT=YES) + `#EXT-X-STREAM-INF` → `video.m3u8`.
  - `buildMediaPlaylist(segments: Segment[], variant: number): string` — VOD completo, `#EXT-X-MAP:URI="init_{variant}.mp4"`, `#EXTINF` con duración real por segmento, `seg_{variant}_{index%05d}.m4s`, `#EXT-X-ENDLIST`.
- Consumes: `AudioTrack` (Task 5).

- [ ] **Step 1: Failing tests**

`server/test/planner.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { planSegments, segmentForTime, buildMasterPlaylist, buildMediaPlaylist } from '../src/media/planner.js'

describe('planSegments', () => {
  it('uniform 4s cuts without keyframes', () => {
    const segs = planSegments(10, null)
    expect(segs.map(s => [s.start, s.duration])).toEqual([[0, 4], [4, 4], [8, 2]])
  })
  it('keyframe-aligned cuts (first kf >= 4s from previous cut)', () => {
    const segs = planSegments(12, [0, 2, 4.5, 6, 9.1, 11])
    expect(segs.map(s => s.start)).toEqual([0, 4.5, 9.1])
    expect(segs.at(-1)!.duration).toBeCloseTo(2.9)
  })
})

describe('segmentForTime', () => {
  it('maps times to segment index', () => {
    const segs = planSegments(10, null)
    expect(segmentForTime(segs, 0)).toBe(0)
    expect(segmentForTime(segs, 4.1)).toBe(1)
    expect(segmentForTime(segs, 9.9)).toBe(2)
  })
})

describe('playlists', () => {
  const audio = [
    { index: 0, codec: 'aac', lang: 'spa', label: 'Español', channels: 2 },
    { index: 1, codec: 'aac', lang: 'eng', label: 'English', channels: 2 },
  ]
  it('master lists audio renditions and one variant', () => {
    const m = buildMasterPlaylist(audio)
    expect(m).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Español",LANGUAGE="spa",DEFAULT=YES,AUTOSELECT=YES,URI="audio_1.m3u8"')
    expect(m).toContain('URI="audio_2.m3u8"')
    expect(m).toContain('AUDIO="aud"')
    expect(m.trim().endsWith('video.m3u8')).toBe(true)
  })
  it('media playlist is a full VOD with map and endlist', () => {
    const p = buildMediaPlaylist(planSegments(10, null), 0)
    expect(p).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(p).toContain('#EXT-X-MAP:URI="init_0.mp4"')
    expect(p).toContain('seg_0_00000.m4s')
    expect(p).toContain('seg_0_00002.m4s')
    expect(p).toContain('#EXTINF:2.000000,')
    expect(p.trim().endsWith('#EXT-X-ENDLIST')).toBe(true)
  })
})
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implementación**

`server/src/media/planner.ts`:
```ts
import type { AudioTrack } from './probe.js'

export interface Segment { index: number; start: number; duration: number }

export function planSegments(durationSec: number, keyframes: number[] | null, target = 4): Segment[] {
  const bounds: number[] = [0]
  if (keyframes && keyframes.length > 0) {
    let last = 0
    for (const k of keyframes) if (k - last >= target && k < durationSec) { bounds.push(k); last = k }
  } else {
    for (let t = target; t < durationSec; t += target) bounds.push(t)
  }
  return bounds.map((start, i) => ({
    index: i, start,
    duration: (i + 1 < bounds.length ? bounds[i + 1] : durationSec) - start,
  }))
}

export function segmentForTime(segments: Segment[], t: number): number {
  for (let i = segments.length - 1; i >= 0; i--) if (segments[i].start <= t) return i
  return 0
}

export function buildMasterPlaylist(audio: AudioTrack[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7']
  audio.forEach((a, i) => lines.push(
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${a.label}",LANGUAGE="${a.lang}",DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,URI="audio_${a.index + 1}.m3u8"`))
  lines.push('#EXT-X-STREAM-INF:BANDWIDTH=8000000,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"', 'video.m3u8')
  return lines.join('\n') + '\n'
}

export function buildMediaPlaylist(segments: Segment[], variant: number): string {
  const target = Math.ceil(Math.max(...segments.map(s => s.duration)))
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', `#EXT-X-MAP:URI="init_${variant}.mp4"`]
  for (const s of segments) {
    lines.push(`#EXTINF:${s.duration.toFixed(6)},`)
    lines.push(`seg_${variant}_${String(s.index).padStart(5, '0')}.m4s`)
  }
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n') + '\n'
}
```

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: segment planning and HLS playlist generation"`

---

### Task 7: Detección de encoder hardware + args de ffmpeg

**Files:**
- Create: `server/src/media/hwaccel.ts`, `server/src/media/ffmpegArgs.ts`
- Test: `server/test/hwaccel.test.ts`, `server/test/ffmpegArgs.test.ts`

**Interfaces:**
- Consumes: `Segment` (Task 6).
- Produces:
  - `parseEncoders(encodersOutput: string, platform: NodeJS.Platform): string` — elige entre `h264_videotoolbox` (darwin), `h264_nvenc`/`h264_qsv` (win32, en ese orden), fallback `libx264`. Solo si aparecen en el listado.
  - `detectEncoder(): Promise<string>` — ejecuta `ffmpeg -hide_banner -encoders`, pasa por `parseEncoders`, cachea el resultado en módulo.
  - `interface TranscodeArgsInput { input: string; mode: 'copy' | 'transcode'; encoder: string; startSegment: number; segments: Segment[]; audioCount: number; outDir: string }`
  - `buildTranscodeArgs(x: TranscodeArgsInput): string[]`

- [ ] **Step 1: Failing tests**

`server/test/hwaccel.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseEncoders } from '../src/media/hwaccel.js'

const OUT = (names: string[]) => names.map(n => ` V....D ${n}  desc`).join('\n')

describe('parseEncoders', () => {
  it('picks videotoolbox on darwin when available', () => {
    expect(parseEncoders(OUT(['libx264', 'h264_videotoolbox']), 'darwin')).toBe('h264_videotoolbox')
  })
  it('prefers nvenc over qsv on win32', () => {
    expect(parseEncoders(OUT(['libx264', 'h264_qsv', 'h264_nvenc']), 'win32')).toBe('h264_nvenc')
  })
  it('falls back to libx264', () => {
    expect(parseEncoders(OUT(['libx264']), 'darwin')).toBe('libx264')
  })
})
```

`server/test/ffmpegArgs.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildTranscodeArgs } from '../src/media/ffmpegArgs.js'
import { planSegments } from '../src/media/planner.js'

const base = { input: '/x/in.mkv', encoder: 'libx264', segments: planSegments(20, null), audioCount: 2, outDir: '/tmp/out' }

describe('buildTranscodeArgs', () => {
  it('copy mode from segment 0: no -ss, -c:v copy, audio renditions, var_stream_map', () => {
    const a = buildTranscodeArgs({ ...base, mode: 'copy', startSegment: 0 })
    expect(a).not.toContain('-ss')
    expect(a.join(' ')).toContain('-c:v copy')
    expect(a.join(' ')).toContain('-var_stream_map v:0,agroup:aud a:0,agroup:aud a:1,agroup:aud')
    expect(a.join(' ')).toContain('-start_number 0')
    expect(a.join(' ')).toContain('seg_%v_%05d.m4s')
  })
  it('transcode mode seeks to segment start and forces keyframes', () => {
    const a = buildTranscodeArgs({ ...base, mode: 'transcode', startSegment: 2 })
    const i = a.indexOf('-ss')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(Number(a[i + 1])).toBeCloseTo(8)
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'))
    expect(a.join(' ')).toContain('-force_key_frames expr:gte(t,n_forced*4)')
    expect(a.join(' ')).toContain('-start_number 2')
  })
})
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implementación**

`server/src/media/hwaccel.ts`:
```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'

const pExecFile = promisify(execFile)
let cached: string | null = null

export function parseEncoders(encodersOutput: string, platform: NodeJS.Platform): string {
  const has = (name: string) => new RegExp(`\\b${name}\\b`).test(encodersOutput)
  if (platform === 'darwin' && has('h264_videotoolbox')) return 'h264_videotoolbox'
  if (platform === 'win32') {
    if (has('h264_nvenc')) return 'h264_nvenc'
    if (has('h264_qsv')) return 'h264_qsv'
  }
  return 'libx264'
}

export async function detectEncoder(): Promise<string> {
  if (cached) return cached
  const { stdout } = await pExecFile(ffmpegPath as string, ['-hide_banner', '-encoders'])
  cached = parseEncoders(stdout, process.platform)
  return cached
}
```

`server/src/media/ffmpegArgs.ts`:
```ts
import { join } from 'node:path'
import type { Segment } from './planner.js'

export interface TranscodeArgsInput {
  input: string; mode: 'copy' | 'transcode'; encoder: string
  startSegment: number; segments: Segment[]; audioCount: number; outDir: string
}

const ENCODER_FLAGS: Record<string, string[]> = {
  libx264: ['-preset', 'veryfast', '-crf', '21'],
  h264_videotoolbox: ['-b:v', '6M'],
  h264_nvenc: ['-preset', 'p4', '-cq', '23'],
  h264_qsv: ['-global_quality', '23'],
}

export function buildTranscodeArgs(x: TranscodeArgsInput): string[] {
  const seg = x.segments[x.startSegment]
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y']
  if (seg.start > 0) args.push('-ss', seg.start.toFixed(6))
  args.push('-i', x.input, '-map', '0:v:0')
  if (x.mode === 'copy') args.push('-c:v', 'copy')
  else args.push('-c:v', x.encoder, ...(ENCODER_FLAGS[x.encoder] ?? []),
    '-force_key_frames', 'expr:gte(t,n_forced*4)', '-pix_fmt', 'yuv420p')
  for (let i = 0; i < x.audioCount; i++) args.push('-map', `0:a:${i}`)
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '128k')
  const vsm = ['v:0,agroup:aud', ...Array.from({ length: x.audioCount }, (_, i) => `a:${i},agroup:aud`)].join(' ')
  args.push(
    '-f', 'hls', '-hls_time', '4', '-hls_segment_type', 'fmp4',
    '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments+temp_file',
    '-start_number', String(x.startSegment),
    '-hls_segment_filename', join(x.outDir, 'seg_%v_%05d.m4s'),
    '-hls_fmp4_init_filename', 'init_%v.mp4',
    '-var_stream_map', vsm,
    join(x.outDir, 'ffm_%v.m3u8'),
  )
  return args
}
```

Las playlists `ffm_%v.m3u8` que escribe ffmpeg **no se sirven** — servimos las nuestras (Task 6); solo importan los `.m4s` e `init_%v.mp4`.

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: hw encoder detection and ffmpeg HLS args builder"`

---

### Task 8: TranscodeSession (integración ffmpeg real)

**Files:**
- Create: `server/src/media/transcoder.ts`
- Test: `server/test/transcoder.test.ts`

**Interfaces:**
- Consumes: `buildTranscodeArgs` (Task 7), `Segment` (Task 6).
- Produces: clase `TranscodeSession`:
  - `constructor(opts: { input: string; mode: 'copy' | 'transcode'; encoder: string; segments: Segment[]; audioCount: number; outDir: string })`
  - `start(fromSegment?: number): void` — spawn ffmpeg (bin de ffmpeg-static). Guarda las últimas 50 líneas de stderr en `lastLog: string[]`.
  - `requestSegment(variant: number, index: number, timeoutMs?: number): Promise<string>` — resuelve con la ruta del archivo cuando está listo. Listo = el archivo existe **y** (existe un `seg_{variant}_{index+1}` o ffmpeg terminó con éxito). Si `index < startSegment` actual o la sesión no avanza hacia él, reinicia con `seekTo(index)`. Poll cada 200 ms; timeout por defecto 30 000 ms → rechaza.
  - `seekTo(segmentIndex: number): void` — mata el proceso y relanza con `startSegment = segmentIndex`.
  - `stop(): Promise<void>` — mata el proceso y espera su salida.
  - `onError(cb: (log: string[]) => void)` — se dispara si ffmpeg sale con código ≠ 0 sin que fuera un kill nuestro.

- [ ] **Step 1: Failing test**

`server/test/transcoder.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureMkv } from './support/fixture.js'
import { extractKeyframes, probeFile } from '../src/media/probe.js'
import { planSegments } from '../src/media/planner.js'
import { TranscodeSession } from '../src/media/transcoder.js'

let fixture: string, session: TranscodeSession, outDir: string

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsc-'))
  fixture = await makeFixtureMkv(dir, { seconds: 30, withSubs: false })
  outDir = join(dir, 'out'); mkdirSync(outDir)
  const info = await probeFile(fixture)
  const kf = await extractKeyframes(fixture)
  session = new TranscodeSession({
    input: fixture, mode: 'copy', encoder: 'libx264',
    segments: planSegments(info.durationSec, kf), audioCount: 2, outDir,
  })
})
afterAll(async () => { await session?.stop() })

describe('TranscodeSession', () => {
  it('produces early video and audio segments', async () => {
    session.start()
    const v0 = await session.requestSegment(0, 0)
    expect(existsSync(v0)).toBe(true)
    expect(existsSync(await session.requestSegment(1, 0))).toBe(true)
    expect(existsSync(await session.requestSegment(2, 1))).toBe(true)
    expect(existsSync(join(outDir, 'init_0.mp4'))).toBe(true)
  })

  it('seek restart produces the requested later segment', async () => {
    const last = session['segments'].length - 1
    const p = await session.requestSegment(0, last, 45_000)
    expect(existsSync(p)).toBe(true)
  })
})
```

- [ ] **Step 2: Run** — Expected: FAIL (clase no existe).
- [ ] **Step 3: Implementación**

`server/src/media/transcoder.ts`:
```ts
import { spawn, ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { buildTranscodeArgs } from './ffmpegArgs.js'
import type { Segment } from './planner.js'

interface Opts { input: string; mode: 'copy' | 'transcode'; encoder: string; segments: Segment[]; audioCount: number; outDir: string }

export class TranscodeSession {
  lastLog: string[] = []
  private proc: ChildProcess | null = null
  private startSegment = 0
  private finished = false
  private killing = false
  private errorCb: ((log: string[]) => void) | null = null
  private segments: Segment[]

  constructor(private opts: Opts) { this.segments = opts.segments }

  start(fromSegment = 0): void {
    this.startSegment = fromSegment
    this.finished = false
    const args = buildTranscodeArgs({ ...this.opts, startSegment: fromSegment })
    this.proc = spawn(ffmpegPath as string, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.proc.stderr!.on('data', (d: Buffer) => {
      this.lastLog.push(...d.toString().split('\n').filter(Boolean))
      this.lastLog = this.lastLog.slice(-50)
    })
    this.proc.on('exit', code => {
      if (code === 0) this.finished = true
      else if (!this.killing) this.errorCb?.(this.lastLog)
      this.killing = false
    })
  }

  onError(cb: (log: string[]) => void): void { this.errorCb = cb }

  seekTo(segmentIndex: number): void {
    this.killProc()
    this.start(segmentIndex)
  }

  private segPath(variant: number, index: number): string {
    return join(this.opts.outDir, `seg_${variant}_${String(index).padStart(5, '0')}.m4s`)
  }

  private isReady(variant: number, index: number): boolean {
    if (!existsSync(this.segPath(variant, index))) return false
    return this.finished || existsSync(this.segPath(variant, index + 1))
  }

  async requestSegment(variant: number, index: number, timeoutMs = 30_000): Promise<string> {
    if (this.isReady(variant, index)) return this.segPath(variant, index)
    if (index < this.startSegment && !existsSync(this.segPath(variant, index))) this.seekTo(index)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.isReady(variant, index)) return this.segPath(variant, index)
      if (this.finished && existsSync(this.segPath(variant, index))) return this.segPath(variant, index)
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`Timeout esperando segmento v${variant}#${index}`)
  }

  private killProc(): void {
    if (this.proc && this.proc.exitCode === null) { this.killing = true; this.proc.kill('SIGKILL') }
    this.proc = null
  }

  async stop(): Promise<void> {
    const p = this.proc
    this.killProc()
    if (p && p.exitCode === null) await new Promise(r => p.once('exit', r))
  }
}
```

Nota de diseño: `requestSegment` sobre un índice muy por delante del actual simplemente espera; el salto proactivo lo decide la capa HTTP (Task 11) usando `segmentForTime` cuando llega un seek — aquí solo cubrimos el caso «pedido por detrás del inicio actual y no está en disco».

- [ ] **Step 4: Run `npx vitest run test/transcoder.test.ts`** — Expected: PASS (tarda: transcodifica 30 s de vídeo). Si el segundo test agota tiempo, sube el timeout del test, no el poll.
- [ ] **Step 5: Añadir a Task 11 pendiente mental:** nada — interfaz cerrada aquí.
- [ ] **Step 6: Commit** — `git commit -am "feat: transcode session with segment wait and seek restart"`

---

### Task 9: Subtítulos → WebVTT

**Files:**
- Create: `server/src/media/subtitles.ts`
- Test: `server/test/subtitles.test.ts`

**Interfaces:**
- Consumes: `MediaInfo`, `SubTrack` (Task 5); `LibraryItem.srtFiles` (Task 4).
- Produces:
  - `interface SubtitleOption { id: number; label: string; lang: string }` — ids: `0..` primero incrustadas textBased (en orden), luego externas.
  - `listSubtitleOptions(info: MediaInfo, srtFiles: string[]): SubtitleOption[]` — externas con label = nombre de archivo sin extensión; las no-textBased se excluyen.
  - `extractSubtitle(input: string, info: MediaInfo, srtFiles: string[], id: number, outVtt: string): Promise<void>` — incrustada: `ffmpeg -i input -map 0:s:<index> -f webvtt out`; externa: `ffmpeg -i srt -f webvtt out`.

- [ ] **Step 1: Failing test**

`server/test/subtitles.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureMkv } from './support/fixture.js'
import { probeFile } from '../src/media/probe.js'
import { listSubtitleOptions, extractSubtitle } from '../src/media/subtitles.js'

let dir: string, fixture: string, info: Awaited<ReturnType<typeof probeFile>>, extSrt: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'subs-'))
  fixture = await makeFixtureMkv(dir)
  info = await probeFile(fixture)
  extSrt = join(dir, 'fixture.es.srt')
  writeFileSync(extSrt, '1\n00:00:00,500 --> 00:00:02,000\nExterno\n')
})

describe('subtitles', () => {
  it('lists embedded text subs then external srt', () => {
    const opts = listSubtitleOptions(info, [extSrt])
    expect(opts).toHaveLength(2)
    expect(opts[0].id).toBe(0)
    expect(opts[1].label).toBe('fixture.es')
  })
  it('extracts embedded track to vtt', async () => {
    const out = join(dir, 'emb.vtt')
    await extractSubtitle(fixture, info, [extSrt], 0, out)
    expect(readFileSync(out, 'utf8')).toContain('WEBVTT')
    expect(readFileSync(out, 'utf8')).toContain('Hola fixture')
  })
  it('converts external srt to vtt', async () => {
    const out = join(dir, 'ext.vtt')
    await extractSubtitle(fixture, info, [extSrt], 1, out)
    expect(readFileSync(out, 'utf8')).toContain('Externo')
  })
})
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implementación**

`server/src/media/subtitles.ts`:
```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import type { MediaInfo } from './probe.js'

const pExecFile = promisify(execFile)

export interface SubtitleOption { id: number; label: string; lang: string }

export function listSubtitleOptions(info: MediaInfo, srtFiles: string[]): SubtitleOption[] {
  const embedded = info.subs.filter(s => s.textBased)
  const opts: SubtitleOption[] = embedded.map((s, i) => ({ id: i, label: s.label, lang: s.lang }))
  srtFiles.forEach((f, i) => opts.push({ id: embedded.length + i, label: basename(f, '.srt'), lang: 'und' }))
  return opts
}

export async function extractSubtitle(input: string, info: MediaInfo, srtFiles: string[], id: number, outVtt: string): Promise<void> {
  const embedded = info.subs.filter(s => s.textBased)
  if (id < embedded.length) {
    await pExecFile(ffmpegPath as string, ['-y', '-i', input, '-map', `0:s:${embedded[id].index}`, '-f', 'webvtt', outVtt])
  } else {
    const srt = srtFiles[id - embedded.length]
    if (!srt) throw new Error(`Subtítulo ${id} no existe`)
    await pExecFile(ffmpegPath as string, ['-y', '-i', srt, '-f', 'webvtt', outVtt])
  }
}
```

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: subtitle extraction to WebVTT"`

---

### Task 10: Estado de sincronización (puro)

**Files:**
- Create: `server/src/rooms/syncState.ts`
- Test: `server/test/syncState.test.ts`

**Interfaces:**
- Produces:
  - `interface PlaybackState { paused: boolean; positionBase: number; updatedAt: number }` (ms epoch en `updatedAt`, segundos en `positionBase`)
  - `type SyncAction = { type: 'play'; at: number } | { type: 'pause'; at: number } | { type: 'seek'; position: number; at: number }`
  - `initialState(at: number): PlaybackState` — pausado en 0.
  - `positionAt(s: PlaybackState, now: number): number`
  - `apply(s: PlaybackState, a: SyncAction): PlaybackState`

- [ ] **Step 1: Failing test**

`server/test/syncState.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { initialState, positionAt, apply } from '../src/rooms/syncState.js'

describe('syncState', () => {
  it('starts paused at 0', () => {
    const s = initialState(1000)
    expect(positionAt(s, 99_999)).toBe(0)
  })
  it('advances while playing, freezes on pause', () => {
    let s = apply(initialState(0), { type: 'play', at: 0 })
    expect(positionAt(s, 10_000)).toBeCloseTo(10)
    s = apply(s, { type: 'pause', at: 10_000 })
    expect(positionAt(s, 60_000)).toBeCloseTo(10)
  })
  it('seek moves position preserving paused flag', () => {
    let s = apply(initialState(0), { type: 'play', at: 0 })
    s = apply(s, { type: 'seek', position: 300, at: 5_000 })
    expect(s.paused).toBe(false)
    expect(positionAt(s, 7_000)).toBeCloseTo(302)
  })
})
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implementación**

`server/src/rooms/syncState.ts`:
```ts
export interface PlaybackState { paused: boolean; positionBase: number; updatedAt: number }
export type SyncAction =
  | { type: 'play'; at: number }
  | { type: 'pause'; at: number }
  | { type: 'seek'; position: number; at: number }

export const initialState = (at: number): PlaybackState => ({ paused: true, positionBase: 0, updatedAt: at })

export const positionAt = (s: PlaybackState, now: number): number =>
  s.paused ? s.positionBase : s.positionBase + (now - s.updatedAt) / 1000

export function apply(s: PlaybackState, a: SyncAction): PlaybackState {
  switch (a.type) {
    case 'play': return { paused: false, positionBase: positionAt(s, a.at), updatedAt: a.at }
    case 'pause': return { paused: true, positionBase: positionAt(s, a.at), updatedAt: a.at }
    case 'seek': return { paused: s.paused, positionBase: a.position, updatedAt: a.at }
  }
}
```

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: authoritative playback sync state"`

---

### Task 11: Salas, seguridad y API REST + streaming

**Files:**
- Create: `server/src/http/security.ts`, `server/src/rooms/roomManager.ts`, `server/src/http/api.ts`
- Modify: `server/src/app.ts` (registrar cookie plugin, rutas, `AppDeps`)
- Test: `server/test/security.test.ts`, `server/test/api.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 6, 8, 9, 10.
- Produces:
  - `isPathInside(root: string, p: string): boolean` (resuelve y compara con separador).
  - `interface Room { token: string; item: LibraryItem; info: MediaInfo; segments: Segment[]; subtitles: SubtitleOption[]; session: SessionLike; state: PlaybackState; chat: ChatEntry[]; error: string[] | null; roomDir: string }` — `ChatEntry` se define en Task 12; hasta entonces usar `chat: unknown[]`. `SessionLike` = interfaz estructural con los métodos de `TranscodeSession` usados (`start/requestSegment/seekTo/stop/onError/lastLog`), para poder inyectar mocks.
  - `class RoomManager { constructor(deps: { createSession: (item: LibraryItem, info: MediaInfo, segments: Segment[], roomDir: string) => SessionLike }); create(item: LibraryItem): Promise<Room>; get(token: string): Room | undefined; close(token: string): Promise<void>; retry(token: string): Promise<void>; all(): Room[] }` — `retry` recrea la sesión con `forceTranscode = true` (el spec exige que reintentar tras un fallo en modo copy fuerce transcodificación). — `create` hace probe + keyframes (solo si `videoCodec === 'h264'`) + planSegments + extrae **todas** las opciones de subtítulos a `<roomDir>/sub_<id>.vtt` + arranca la sesión. Token = `randomBytes(16).toString('base64url')`. `roomDir` = `<cacheDir()>/<token>`. `close` para la sesión y borra `roomDir`.
  - `AppDeps` pasa a: `{ config: Config; library: () => Promise<LibraryItem[]>; rooms: RoomManager; adminToken: string }`.
  - Rutas (todas en `server/src/http/api.ts`, registradas por `buildApp`):
    - `GET /api/library` (admin) → `LibraryItem[]`
    - `POST /api/library/rescan` (admin) → re-escanea
    - `POST /api/rooms` (admin, body `{ itemId }`) → `{ token }`
    - `DELETE /api/rooms/:token` (admin)
    - `GET /api/rooms/:token` (público) → `{ title, durationSec, audio: AudioTrack[], subtitles: SubtitleOption[], error }`
    - `GET /stream/:token/:file` (público) — dispatch por regex: `master.m3u8` → `buildMasterPlaylist`; `video.m3u8` → `buildMediaPlaylist(segs, 0)`; `audio_(\d+).m3u8` → variante n; `init_(\d+).mp4` y `seg_(\d+)_(\d+).m4s` → archivo del roomDir (segmentos vía `session.requestSegment`); `sub_(\d+).vtt` → vtt del roomDir. Cualquier otro nombre → 404. Content-types: `application/vnd.apple.mpegurl`, `video/mp4`, `text/vtt`.
  - Admin = cookie `admin` igual a `adminToken`, o query `?key=` (que además setea la cookie). Hook `requireAdmin` en `security.ts`.

- [ ] **Step 1: Failing tests de seguridad**

`server/test/security.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { isPathInside } from '../src/http/security.js'

describe('isPathInside', () => {
  it.each([
    ['/media', '/media/peli.mkv', true],
    ['/media', '/media/sub/x.mp4', true],
    ['/media', '/media/../etc/passwd', false],
    ['/media', '/mediafalso/x.mkv', false],
  ])('root=%s p=%s -> %s', (root, p, ok) => {
    expect(isPathInside(root, p)).toBe(ok)
  })
})
```

- [ ] **Step 2: Failing tests de API** (sesión mockeada — sin ffmpeg de verdad salvo probe)

`server/test/api.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { RoomManager } from '../src/rooms/roomManager.js'
import { makeFixtureMkv } from './support/fixture.js'
import { scanLibrary } from '../src/library/scanner.js'

let app: Awaited<ReturnType<typeof buildApp>>, mediaDir: string, token: string
const ADMIN = 'test-admin-token'

const fakeSession = {
  start: () => {}, seekTo: () => {}, stop: async () => {}, onError: () => {}, lastLog: [] as string[],
  requestSegment: async (v: number, i: number) => {
    const p = join(process.env.JBG_DATA_DIR!, 'fake.m4s'); writeFileSync(p, 'seg'); return p
  },
}

beforeAll(async () => {
  process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'api-'))
  mediaDir = mkdtempSync(join(tmpdir(), 'apimedia-'))
  await makeFixtureMkv(mediaDir)
  app = await buildApp({
    config: { mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'Host', cacheLimitGB: 10 },
    library: () => scanLibrary([mediaDir]),
    rooms: new RoomManager({ createSession: () => fakeSession }),
    adminToken: ADMIN,
  })
})
afterAll(async () => { await app.close() })

const admin = { cookies: { admin: ADMIN } }

describe('api', () => {
  it('library requires admin', async () => {
    expect((await app.inject({ url: '/api/library' })).statusCode).toBe(401)
    const res = await app.inject({ url: '/api/library', ...admin })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
  })

  it('creates a room and exposes public room info', async () => {
    const items = (await app.inject({ url: '/api/library', ...admin })).json()
    const res = await app.inject({ method: 'POST', url: '/api/rooms', payload: { itemId: items[0].id }, ...admin })
    expect(res.statusCode).toBe(200)
    token = res.json().token
    expect(token.length).toBeGreaterThan(15)
    const info = (await app.inject({ url: `/api/rooms/${token}` })).json()
    expect(info.audio).toHaveLength(2)
    expect(info.subtitles.length).toBeGreaterThanOrEqual(1)
  })

  it('serves master and media playlists', async () => {
    const m = await app.inject({ url: `/stream/${token}/master.m3u8` })
    expect(m.statusCode).toBe(200)
    expect(m.body).toContain('audio_1.m3u8')
    const v = await app.inject({ url: `/stream/${token}/video.m3u8` })
    expect(v.body).toContain('#EXT-X-ENDLIST')
  })

  it('serves segments via session and rejects weird paths', async () => {
    const s = await app.inject({ url: `/stream/${token}/seg_0_00000.m4s` })
    expect(s.statusCode).toBe(200)
    expect((await app.inject({ url: `/stream/${token}/../../etc/passwd` })).statusCode).toBe(404)
    expect((await app.inject({ url: `/stream/${token}/evil.txt` })).statusCode).toBe(404)
    expect((await app.inject({ url: `/stream/NOEXISTE/master.m3u8` })).statusCode).toBe(404)
  })
})
```

- [ ] **Step 3: Run** — Expected: FAIL.
- [ ] **Step 4: Implementación**

`server/src/http/security.ts`:
```ts
import { resolve, sep } from 'node:path'
import type { FastifyReply, FastifyRequest } from 'fastify'

export function isPathInside(root: string, p: string): boolean {
  const r = resolve(root), t = resolve(p)
  return t === r || t.startsWith(r + sep)
}

export function makeRequireAdmin(adminToken: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const q = (req.query as Record<string, string>)?.key
    const cookie = (req as any).cookies?.admin
    if (q === adminToken) { reply.setCookie('admin', adminToken, { path: '/', httpOnly: true }); return }
    if (cookie !== adminToken) reply.code(401).send({ error: 'admin required' })
  }
}
```

`server/src/rooms/roomManager.ts`:
```ts
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { cacheDir } from '../config.js'
import type { LibraryItem } from '../library/scanner.js'
import { probeFile, extractKeyframes, type MediaInfo } from '../media/probe.js'
import { planSegments, type Segment } from '../media/planner.js'
import { listSubtitleOptions, extractSubtitle, type SubtitleOption } from '../media/subtitles.js'
import { initialState, type PlaybackState } from './syncState.js'

export interface SessionLike {
  start(fromSegment?: number): void
  requestSegment(variant: number, index: number, timeoutMs?: number): Promise<string>
  seekTo(segmentIndex: number): void
  stop(): Promise<void>
  onError(cb: (log: string[]) => void): void
  lastLog: string[]
}

export interface Room {
  token: string; item: LibraryItem; info: MediaInfo; segments: Segment[]
  subtitles: SubtitleOption[]; session: SessionLike; state: PlaybackState
  chat: unknown[]; error: string[] | null; roomDir: string
}

interface Deps { createSession: (item: LibraryItem, info: MediaInfo, segments: Segment[], roomDir: string, forceTranscode?: boolean) => SessionLike }

export class RoomManager {
  private rooms = new Map<string, Room>()
  constructor(private deps: Deps) {}

  async create(item: LibraryItem): Promise<Room> {
    const token = randomBytes(16).toString('base64url')
    const roomDir = join(cacheDir(), token)
    mkdirSync(roomDir, { recursive: true })
    const info = await probeFile(item.path)
    const keyframes = info.videoCodec === 'h264' ? await extractKeyframes(item.path) : null
    const segments = planSegments(info.durationSec, keyframes)
    const subtitles = listSubtitleOptions(info, item.srtFiles)
    for (const s of subtitles) {
      await extractSubtitle(item.path, info, item.srtFiles, s.id, join(roomDir, `sub_${s.id}.vtt`)).catch(() => {})
    }
    const session = this.deps.createSession(item, info, segments, roomDir)
    const room: Room = { token, item, info, segments, subtitles, session, state: initialState(Date.now()), chat: [], error: null, roomDir }
    session.onError(log => { room.error = log })
    session.start()
    this.rooms.set(token, room)
    return room
  }

  get(token: string): Room | undefined { return this.rooms.get(token) }
  all(): Room[] { return [...this.rooms.values()] }

  async retry(token: string): Promise<void> {
    const room = this.rooms.get(token)
    if (!room) return
    await room.session.stop()
    room.error = null
    room.session = this.deps.createSession(room.item, room.info, room.segments, room.roomDir, true)
    room.session.onError(log => { room.error = log })
    room.session.start()
  }

  async close(token: string): Promise<void> {
    const room = this.rooms.get(token)
    if (!room) return
    await room.session.stop()
    rmSync(room.roomDir, { recursive: true, force: true })
    this.rooms.delete(token)
  }
}
```

`server/src/http/api.ts`:
```ts
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../app.js'
import { buildMasterPlaylist, buildMediaPlaylist } from '../media/planner.js'
import { isPathInside, makeRequireAdmin } from './security.js'

const M3U8 = 'application/vnd.apple.mpegurl'

export function registerApi(app: FastifyInstance, deps: AppDeps): void {
  const requireAdmin = makeRequireAdmin(deps.adminToken)

  app.get('/api/library', { preHandler: requireAdmin }, async () => deps.library())
  app.post('/api/library/rescan', { preHandler: requireAdmin }, async () => deps.library())

  app.post('/api/rooms', { preHandler: requireAdmin }, async (req, reply) => {
    const { itemId } = req.body as { itemId: string }
    const item = (await deps.library()).find(i => i.id === itemId)
    if (!item) return reply.code(404).send({ error: 'item not found' })
    if (!deps.config.mediaFolders.some(f => isPathInside(f, item.path))) return reply.code(400).send({ error: 'path outside media folders' })
    const room = await deps.rooms.create(item)
    return { token: room.token }
  })

  app.delete('/api/rooms/:token', { preHandler: requireAdmin }, async (req) => {
    await deps.rooms.close((req.params as any).token)
    return { ok: true }
  })

  app.get('/api/rooms/:token', async (req, reply) => {
    const room = deps.rooms.get((req.params as any).token)
    if (!room) return reply.code(404).send({ error: 'room not found' })
    return {
      title: room.item.title, durationSec: room.info.durationSec,
      audio: room.info.audio, subtitles: room.subtitles, error: room.error,
    }
  })

  app.get('/stream/:token/:file', async (req, reply) => {
    const { token, file } = req.params as { token: string; file: string }
    const room = deps.rooms.get(token)
    if (!room) return reply.code(404).send()
    if (file === 'master.m3u8') return reply.type(M3U8).send(buildMasterPlaylist(room.info.audio))
    if (file === 'video.m3u8') return reply.type(M3U8).send(buildMediaPlaylist(room.segments, 0))
    const audio = file.match(/^audio_(\d+)\.m3u8$/)
    if (audio) return reply.type(M3U8).send(buildMediaPlaylist(room.segments, Number(audio[1])))
    const init = file.match(/^init_(\d+)\.mp4$/)
    if (init) {
      const p = join(room.roomDir, file)
      if (!isPathInside(room.roomDir, p)) return reply.code(404).send()
      return reply.type('video/mp4').send(createReadStream(p))
    }
    const seg = file.match(/^seg_(\d+)_(\d+)\.m4s$/)
    if (seg) {
      try {
        const p = await room.session.requestSegment(Number(seg[1]), Number(seg[2]))
        return reply.type('video/mp4').send(createReadStream(p))
      } catch { return reply.code(504).send() }
    }
    const sub = file.match(/^sub_(\d+)\.vtt$/)
    if (sub) {
      const p = join(room.roomDir, file)
      if (!isPathInside(room.roomDir, p)) return reply.code(404).send()
      return reply.type('text/vtt').send(createReadStream(p))
    }
    return reply.code(404).send()
  })
}
```

Añadir también la ruta de reintento (pública — cualquier participante puede pulsarla):
```ts
  app.post('/api/rooms/:token/retry', async (req, reply) => {
    const room = deps.rooms.get((req.params as any).token)
    if (!room) return reply.code(404).send()
    await deps.rooms.retry(room.token)
    return { ok: true }
  })
```

`server/src/app.ts` (reemplazar entero):
```ts
import Fastify, { FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import type { Config } from './config.js'
import type { LibraryItem } from './library/scanner.js'
import type { RoomManager } from './rooms/roomManager.js'
import { registerApi } from './http/api.js'

export interface AppDeps {
  config: Config
  library: () => Promise<LibraryItem[]>
  rooms: RoomManager
  adminToken: string
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(cookie)
  app.get('/health', async () => ({ ok: true }))
  registerApi(app, deps)
  return app
}
```

Actualizar `server/test/app.test.ts` para pasar los nuevos `AppDeps` mínimos (config default, `library: async () => []`, un `RoomManager` con factory dummy, `adminToken: 't'`), y `server/src/index.ts` en consecuencia (se completa en Task 15 — de momento basta con que compile usando `RoomManager` real con `TranscodeSession`).

- [ ] **Step 5: Run todos los tests** — Expected: PASS (incluye los de tasks anteriores).
- [ ] **Step 6: Commit** — `git commit -am "feat: rooms, admin auth, REST api and HLS streaming routes"`

---

### Task 12: WebSocket — sync, chat, reacciones, presencia

**Files:**
- Create: `server/src/ws/messages.ts`, `server/src/ws/hub.ts`
- Modify: `server/src/app.ts` (registrar @fastify/websocket y hub), `server/src/rooms/roomManager.ts` (tipar `chat: ChatEntry[]`)
- Test: `server/test/hub.test.ts`

**Interfaces:**
- Consumes: `RoomManager`, `Room` (Task 11); `apply`, `positionAt` (Task 10).
- Produces (`server/src/ws/messages.ts`):
```ts
export interface Participant { id: string; name: string; color: string }
export interface ChatEntry { id: string; from: Participant; kind: 'text' | 'gif' | 'system'; text: string; gifUrl?: string; at: number }
export type ClientMsg =
  | { t: 'join'; name: string }
  | { t: 'play' } | { t: 'pause' } | { t: 'seek'; position: number }
  | { t: 'chat'; text: string }
  | { t: 'gif'; url: string }
  | { t: 'reaction'; emoji: string }
  | { t: 'buffering'; value: boolean }
export type ServerMsg =
  | { t: 'welcome'; self: Participant; participants: Participant[]; state: PlaybackState; serverNow: number; history: ChatEntry[] }
  | { t: 'state'; state: PlaybackState; serverNow: number }
  | { t: 'presence'; participants: Participant[] }
  | { t: 'chat'; entry: ChatEntry }
  | { t: 'reaction'; emoji: string; from: string }
  | { t: 'buffering'; name: string; value: boolean }
```
- Produces (`server/src/ws/hub.ts`): `registerHub(app: FastifyInstance, deps: AppDeps): void` — ruta WS `GET /ws/:token`:
  - Primer mensaje debe ser `join` → asigna `Participant` (id aleatorio, color de paleta rotatoria `['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c']`), responde `welcome`, difunde `presence` + `chat` de sistema («X se unió»).
  - `play`/`pause`/`seek` → `apply` sobre `room.state`, difunde `state` a todos + entry de sistema («X pausó», «X saltó a H:MM:SS» — helper `formatTime(sec)`).
  - Un `seek` además llama `room.session.seekTo(segmentForTime(room.segments, position))` **solo si** el segmento objetivo no existe aún en disco (delegado en un método `ensureAt(position)` que añade el hub usando `segmentForTime` + `existsSync` sobre el roomDir; para el mock de tests basta con que exista `seekTo`).
  - `chat`/`gif` → entry a `room.chat` (cap 500) y difusión.
  - `reaction`/`buffering` → difusión directa sin persistir.
  - Desconexión → `presence` + sistema («X salió»).

- [ ] **Step 1: Failing test** (dos clientes ws reales contra `app.listen` en puerto 0)

`server/test/hub.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { buildApp } from '../src/app.js'
import { RoomManager } from '../src/rooms/roomManager.js'
import { makeFixtureMkv } from './support/fixture.js'
import { scanLibrary } from '../src/library/scanner.js'

let app: Awaited<ReturnType<typeof buildApp>>, url: string, token: string

const fakeSession = {
  start: () => {}, seekTo: () => {}, stop: async () => {}, onError: () => {}, lastLog: [],
  requestSegment: async () => '/dev/null',
}

function connect(name: string): Promise<{ ws: WebSocket; recv: () => Promise<any> }> {
  return new Promise((res) => {
    const ws = new WebSocket(`${url}/ws/${token}`)
    const queue: any[] = []; const waiters: ((m: any) => void)[] = []
    ws.on('message', d => { const m = JSON.parse(d.toString()); const w = waiters.shift(); w ? w(m) : queue.push(m) })
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'join', name })); res({ ws, recv: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(r => waiters.push(r)) }) })
  })
}

beforeAll(async () => {
  process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'hub-'))
  const mediaDir = mkdtempSync(join(tmpdir(), 'hubmedia-'))
  await makeFixtureMkv(mediaDir)
  const rooms = new RoomManager({ createSession: () => fakeSession })
  app = await buildApp({
    config: { mediaFolders: [mediaDir], klipyApiKey: null, port: 8400, hostName: 'H', cacheLimitGB: 10 },
    library: () => scanLibrary([mediaDir]), rooms, adminToken: 'a',
  })
  await app.listen({ port: 0 })
  const port = (app.server.address() as any).port
  url = `ws://127.0.0.1:${port}`
  const items = await scanLibrary([mediaDir])
  token = (await rooms.create(items[0])).token
})
afterAll(async () => { await app.close() })

describe('hub', () => {
  it('welcome + presence + play propagates state and system message', async () => {
    const a = await connect('Ana')
    const wA = await a.recv()
    expect(wA.t).toBe('welcome')
    expect(wA.self.name).toBe('Ana')
    await a.recv() // presence propio
    await a.recv() // system "Ana se unió"
    const b = await connect('Luis')
    await b.recv() // welcome de Luis (incluye history con "Ana se unió")
    await a.recv(); await a.recv() // presence + system de Luis en A
    await b.recv(); await b.recv() // presence + system en B

    a.ws.send(JSON.stringify({ t: 'play' }))
    const msgsB = [await b.recv(), await b.recv()]
    const state = msgsB.find(m => m.t === 'state')!
    expect(state.state.paused).toBe(false)
    expect(typeof state.serverNow).toBe('number')
    const sys = msgsB.find(m => m.t === 'chat')!
    expect(sys.entry.kind).toBe('system')

    a.ws.send(JSON.stringify({ t: 'chat', text: 'hola' }))
    const chatB = await b.recv()
    expect(chatB.entry.text).toBe('hola')

    a.ws.send(JSON.stringify({ t: 'reaction', emoji: '🔥' }))
    const rB = await b.recv()
    expect(rB).toMatchObject({ t: 'reaction', emoji: '🔥', from: 'Ana' })
    a.ws.close(); b.ws.close()
  })
})
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implementación**

`server/src/ws/messages.ts` — exactamente los tipos del bloque Interfaces (importando `PlaybackState` de `../rooms/syncState.js`).

`server/src/ws/hub.ts`:
```ts
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { AppDeps } from '../app.js'
import type { Room } from '../rooms/roomManager.js'
import { apply, positionAt } from '../rooms/syncState.js'
import { segmentForTime } from '../media/planner.js'
import type { ChatEntry, ClientMsg, Participant, ServerMsg } from './messages.js'

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c']
const conns = new Map<Room, Map<WebSocket, Participant>>()

export function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60)
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

export function registerHub(app: FastifyInstance, deps: AppDeps): void {
  app.get('/ws/:token', { websocket: true }, (socket: WebSocket, req) => {
    const room = deps.rooms.get((req.params as any).token)
    if (!room) { socket.close(4004, 'room not found'); return }
    if (!conns.has(room)) conns.set(room, new Map())
    const peers = conns.get(room)!
    let me: Participant | null = null

    const send = (ws: WebSocket, m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)) }
    const broadcast = (m: ServerMsg) => { for (const ws of peers.keys()) send(ws, m) }
    const system = (text: string) => {
      const entry: ChatEntry = { id: randomBytes(6).toString('hex'), from: { id: 'sys', name: 'sistema', color: '#888' }, kind: 'system', text, at: Date.now() }
      ;(room.chat as ChatEntry[]).push(entry)
      room.chat = room.chat.slice(-500)
      broadcast({ t: 'chat', entry })
    }

    socket.on('message', (raw: Buffer) => {
      let msg: ClientMsg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      const now = Date.now()

      if (msg.t === 'join') {
        me = { id: randomBytes(6).toString('hex'), name: msg.name.slice(0, 30) || 'Anónimo', color: COLORS[peers.size % COLORS.length] }
        peers.set(socket, me)
        send(socket, { t: 'welcome', self: me, participants: [...peers.values()], state: room.state, serverNow: now, history: room.chat as ChatEntry[] })
        broadcast({ t: 'presence', participants: [...peers.values()] })
        system(`${me.name} se unió`)
        return
      }
      if (!me) return

      switch (msg.t) {
        case 'play': case 'pause': {
          room.state = apply(room.state, { type: msg.t, at: now })
          broadcast({ t: 'state', state: room.state, serverNow: now })
          system(msg.t === 'play' ? `${me.name} reanudó` : `${me.name} pausó`)
          break
        }
        case 'seek': {
          room.state = apply(room.state, { type: 'seek', position: msg.position, at: now })
          room.session.seekTo(segmentForTime(room.segments, msg.position))
          broadcast({ t: 'state', state: room.state, serverNow: now })
          system(`${me.name} saltó a ${formatTime(msg.position)}`)
          break
        }
        case 'chat': case 'gif': {
          const entry: ChatEntry = {
            id: randomBytes(6).toString('hex'), from: me, at: now,
            kind: msg.t === 'gif' ? 'gif' : 'text',
            text: msg.t === 'chat' ? msg.text.slice(0, 1000) : '',
            gifUrl: msg.t === 'gif' ? msg.url : undefined,
          }
          ;(room.chat as ChatEntry[]).push(entry)
          room.chat = room.chat.slice(-500)
          broadcast({ t: 'chat', entry })
          break
        }
        case 'reaction': broadcast({ t: 'reaction', emoji: msg.emoji.slice(0, 8), from: me.name }); break
        case 'buffering': broadcast({ t: 'buffering', name: me.name, value: msg.value }); break
      }
    })

    socket.on('close', () => {
      if (!me) return
      peers.delete(socket)
      broadcast({ t: 'presence', participants: [...peers.values()] })
      system(`${me.name} salió`)
    })
  })
}
```

En `app.ts`: `await app.register(websocket)` (import `websocket from '@fastify/websocket'`) **antes** de `registerHub(app, deps)`. En `roomManager.ts`, cambiar `chat: unknown[]` por `chat: ChatEntry[]` importando el tipo. Nota: `seekTo` en seek es incondicional aquí; `TranscodeSession.requestSegment` ya resuelve al instante los segmentos que siguen en disco, así que el reinicio redundante solo ocurre al saltar hacia atrás a zona cacheada — aceptable en v1 si el segmento inicial pedido existe (documentado en el spec como parte delicada; si en pruebas reales molesta, condicionar con `existsSync(segPath)`).

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: websocket hub for sync, chat, reactions and presence"`

---

### Task 13: Proxy de GIFs (Klipy)

**Files:**
- Create: `server/src/http/klipy.ts`
- Modify: `server/src/app.ts` (registrar ruta; añadir `fetchImpl?: typeof fetch` a `AppDeps`)
- Test: `server/test/klipy.test.ts`

**Interfaces:**
- Consumes: `AppDeps.config.klipyApiKey`, `deps.rooms`.
- Produces:
  - `interface GifResult { id: string; title: string; previewUrl: string; url: string; width: number; height: number }`
  - Ruta `GET /api/gifs/search?q=<query>&room=<token>` — 404 `{ gifsDisabled: true }` si no hay API key; 401 si `room` no es un token válido; si OK → `{ results: GifResult[] }` (máx. 24).
  - `mapKlipyResponse(json: unknown): GifResult[]` — exportada y testeada por separado; defensiva: item con `files` → busca variante gif en orden `md, hd, sm` para `url` y `sm ?? md` para `previewUrl`; ignora items sin URL utilizable.

- [ ] **Step 1: Verificar el shape real de Klipy.** Con WebFetch (o navegador) sobre `https://docs.klipy.com/gifs-api/search-gifs` confirmar: endpoint `GET https://api.klipy.com/api/v1/{API_KEY}/gifs/search?q=&page=&per_page=` y estructura por item (campo `files` con variantes por tamaño/formato: `{ sm|md|hd: { gif|webp|mp4: { url, width, height } } }`). Si el shape difiere, ajustar `mapKlipyResponse` y su test a lo observado **antes** de escribir el resto. Anotar el shape confirmado en un comentario del módulo.

- [ ] **Step 2: Failing test**

`server/test/klipy.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mapKlipyResponse } from '../src/http/klipy.js'

const sample = {
  result: true,
  data: {
    data: [{
      id: 123, title: 'lol',
      files: {
        sm: { gif: { url: 'https://k/sm.gif', width: 100, height: 80 } },
        md: { gif: { url: 'https://k/md.gif', width: 200, height: 160 } },
      },
    }, { id: 456, title: 'sin-files' }],
    has_next: true,
  },
}

describe('mapKlipyResponse', () => {
  it('maps items defensively', () => {
    const r = mapKlipyResponse(sample)
    expect(r).toHaveLength(1)
    expect(r[0]).toEqual({ id: '123', title: 'lol', previewUrl: 'https://k/sm.gif', url: 'https://k/md.gif', width: 200, height: 160 })
  })
  it('tolerates garbage', () => {
    expect(mapKlipyResponse(null)).toEqual([])
    expect(mapKlipyResponse({ data: {} })).toEqual([])
  })
})
```

- [ ] **Step 3: Run** — Expected: FAIL.
- [ ] **Step 4: Implementación**

`server/src/http/klipy.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import type { AppDeps } from '../app.js'

// Shape confirmado contra docs.klipy.com el AAAA-MM-DD (actualizar al implementar):
// GET https://api.klipy.com/api/v1/{KEY}/gifs/search?q=&page=1&per_page=24
// -> { result, data: { data: [{ id, title, files: { sm|md|hd: { gif|webp|mp4: { url, width, height } } } }], has_next } }
export interface GifResult { id: string; title: string; previewUrl: string; url: string; width: number; height: number }

export function mapKlipyResponse(json: unknown): GifResult[] {
  const items = (json as any)?.data?.data
  if (!Array.isArray(items)) return []
  const out: GifResult[] = []
  for (const it of items) {
    const files = it?.files ?? {}
    const pick = (...sizes: string[]) => { for (const s of sizes) { const f = files[s]?.gif; if (f?.url) return f } return null }
    const main = pick('md', 'hd', 'sm')
    const prev = pick('sm', 'md') ?? main
    if (!main) continue
    out.push({ id: String(it.id), title: String(it.title ?? ''), previewUrl: prev!.url, url: main.url, width: main.width ?? 0, height: main.height ?? 0 })
  }
  return out
}

export function registerKlipy(app: FastifyInstance, deps: AppDeps): void {
  const doFetch = deps.fetchImpl ?? fetch
  app.get('/api/gifs/search', async (req, reply) => {
    const { q, room } = req.query as { q?: string; room?: string }
    if (!deps.config.klipyApiKey) return reply.code(404).send({ gifsDisabled: true })
    if (!room || !deps.rooms.get(room)) return reply.code(401).send({ error: 'valid room required' })
    const url = `https://api.klipy.com/api/v1/${deps.config.klipyApiKey}/gifs/search?q=${encodeURIComponent(q ?? '')}&page=1&per_page=24`
    const res = await doFetch(url)
    if (!res.ok) return reply.code(502).send({ error: 'klipy error' })
    return { results: mapKlipyResponse(await res.json()) }
  })
}
```

En `app.ts`: añadir `fetchImpl?: typeof fetch` a `AppDeps` y llamar `registerKlipy(app, deps)`. Añadir a `api.test.ts` un caso: sin API key → `GET /api/gifs/search?q=x&room=<token>` responde 404 `{ gifsDisabled: true }`; y con `fetchImpl` stub que devuelve el `sample` → 200 con 1 resultado.

- [ ] **Step 5: Run** — Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -am "feat: klipy gif search proxy"`

---

### Task 14: Túnel cloudflared

**Files:**
- Create: `server/src/tunnel/cloudflared.ts`
- Test: `server/test/cloudflared.test.ts`

**Interfaces:**
- Produces:
  - `binaryUrl(platform: NodeJS.Platform, arch: string): { url: string; archive: 'none' | 'tgz' }` — darwin → `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-<amd64|arm64>.tgz` (tgz); win32 → `...cloudflared-windows-amd64.exe`; linux → `...cloudflared-linux-<amd64|arm64>`.
  - `parseTunnelUrl(line: string): string | null` — extrae `https://<sub>.trycloudflare.com`.
  - `ensureBinary(): Promise<string>` — descarga a `<dataDir>/bin/cloudflared[.exe]` si no existe (fetch → archivo; tgz se extrae con `tar -xzf` vía child_process; `chmod 755` en unix). Devuelve la ruta.
  - `class Tunnel { constructor(port: number); start(): void; stop(): void; url: string | null; onUrl(cb: (url: string) => void): void; onDown(cb: () => void): void }` — spawn `cloudflared tunnel --url http://localhost:<port>`, parsea stderr con `parseTunnelUrl`; si el proceso muere sin `stop()`, reintenta con backoff 1s→2s→4s (máx 30s) y emite `onDown`.

- [ ] **Step 1: Failing tests (solo puros)**

`server/test/cloudflared.test.ts`:
```ts
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
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implementación**

`server/src/tunnel/cloudflared.ts`:
```ts
import { spawn, execFileSync, ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
  private urlCb: ((u: string) => void) | null = null
  private downCb: (() => void) | null = null

  constructor(private port: number) {}
  onUrl(cb: (u: string) => void): void { this.urlCb = cb }
  onDown(cb: () => void): void { this.downCb = cb }

  start(): void {
    this.stopped = false
    void ensureBinary().then(bin => {
      if (this.stopped) return
      this.proc = spawn(bin, ['tunnel', '--url', `http://localhost:${this.port}`], { stdio: ['ignore', 'ignore', 'pipe'] })
      this.proc.stderr!.on('data', (d: Buffer) => {
        for (const line of d.toString().split('\n')) {
          const u = parseTunnelUrl(line)
          if (u && u !== this.url) { this.url = u; this.attempt = 0; this.urlCb?.(u) }
        }
      })
      this.proc.on('exit', () => {
        if (this.stopped) return
        this.url = null
        this.downCb?.()
        const delay = Math.min(1000 * 2 ** this.attempt++, 30_000)
        setTimeout(() => this.start(), delay)
      })
    })
  }

  stop(): void { this.stopped = true; this.proc?.kill() }
}
```

- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Verificación manual (una vez):** `node -e` breve o script temporal que haga `new Tunnel(8400).start()` con `onUrl(console.log)` — debe imprimir una URL `trycloudflare.com` en <30 s. No automatizar (depende de red externa).
- [ ] **Step 6: Commit** — `git commit -am "feat: cloudflared tunnel with auto-download and restart"`

---

### Task 15: Entry point — wiring completo, caché y navegador

**Files:**
- Create: `server/src/media/cachePrune.ts`
- Modify: `server/src/index.ts`, `server/src/app.ts` (ruta `/api/status`, servir estáticos si existe `web/dist`, añadir `tunnel` a deps)
- Test: `server/test/status.test.ts`, `server/test/cachePrune.test.ts`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces:
  - `AppDeps` gana `tunnel: { url: string | null }` (interfaz estructural — la clase `Tunnel` la cumple).
  - `GET /api/status` (admin) → `{ tunnelUrl: string | null, rooms: { token: string; title: string }[] }`.
  - `server/src/media/cachePrune.ts` (límite de caché del spec):
    - `pickPrunable(files: { path: string; mtimeMs: number; size: number }[], limitBytes: number): string[]` — pura: si el total supera el límite, devuelve los paths más antiguos hasta quedar por debajo.
    - `segmentFilesWithStats(dir: string): { path: string; mtimeMs: number; size: number }[]` — lee los `.m4s` de un dir con `statSync` (dir inexistente → `[]`).
  - `server/src/index.ts` hace: `loadConfig()` → `rmSync(cacheDir(), {recursive, force})` + recrear → construir `RoomManager` con `createSession` real (usa `probeFile`-info: `mode = videoCodec === 'h264' ? 'copy' : 'transcode'`, `encoder = await detectEncoder()`) → `buildApp` con `adminToken = randomBytes(12).toString('base64url')` → listen en `config.port`, host `0.0.0.0` → `new Tunnel(port).start()` con `onUrl` log «Comparte: <url>/room/<token>» → abrir navegador en `http://localhost:<port>/?key=<adminToken>` (darwin: `spawn('open', [url])`; win32: `spawn('cmd', ['/c', 'start', '', url])`) → SIGINT limpia salas y túnel.

- [ ] **Step 1: Failing test**

`server/test/status.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { RoomManager } from '../src/rooms/roomManager.js'

describe('/api/status', () => {
  it('reports tunnel url and rooms, admin only', async () => {
    process.env.JBG_DATA_DIR = mkdtempSync(join(tmpdir(), 'st-'))
    const app = await buildApp({
      config: { mediaFolders: [], klipyApiKey: null, port: 8400, hostName: 'H', cacheLimitGB: 10 },
      library: async () => [],
      rooms: new RoomManager({ createSession: () => ({ start() {}, seekTo() {}, async stop() {}, onError() {}, lastLog: [], requestSegment: async () => '' }) }),
      adminToken: 'adm', tunnel: { url: 'https://x.trycloudflare.com' },
    })
    expect((await app.inject({ url: '/api/status' })).statusCode).toBe(401)
    const res = await app.inject({ url: '/api/status', cookies: { admin: 'adm' } })
    expect(res.json()).toEqual({ tunnelUrl: 'https://x.trycloudflare.com', rooms: [] })
    await app.close()
  })
})
```

`server/test/cachePrune.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { pickPrunable } from '../src/media/cachePrune.js'

const f = (path: string, mtimeMs: number, size: number) => ({ path, mtimeMs, size })

describe('pickPrunable', () => {
  it('returns nothing under the limit', () => {
    expect(pickPrunable([f('a', 1, 100), f('b', 2, 100)], 500)).toEqual([])
  })
  it('drops oldest files until under limit', () => {
    expect(pickPrunable([f('new', 3, 100), f('old', 1, 100), f('mid', 2, 100)], 150)).toEqual(['old', 'mid'])
  })
})
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implementación** — añadir a `AppDeps`: `tunnel: { url: string | null }`; en `registerApi`: ruta `/api/status` con `preHandler: requireAdmin` que devuelve `{ tunnelUrl: deps.tunnel.url, rooms: deps.rooms.all().map(r => ({ token: r.token, title: r.item.title })) }`. Actualizar los `buildApp({...})` de los tests anteriores añadiendo `tunnel: { url: null }`. En `app.ts`, si `existsSync` de `web/dist` (ruta `new URL('../../web/dist', import.meta.url)`), registrar `@fastify/static` con `root` ahí y `wildcard: false`, más un `setNotFoundHandler` que sirva `index.html` para rutas no-API (SPA fallback: solo si `!req.url.startsWith('/api') && !req.url.startsWith('/stream') && !req.url.startsWith('/ws')`).

`server/src/media/cachePrune.ts`:
```ts
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface PrunableFile { path: string; mtimeMs: number; size: number }

export function pickPrunable(files: PrunableFile[], limitBytes: number): string[] {
  let total = files.reduce((s, f) => s + f.size, 0)
  const out: string[] = []
  for (const f of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= limitBytes) break
    out.push(f.path)
    total -= f.size
  }
  return out
}

export function segmentFilesWithStats(dir: string): PrunableFile[] {
  try {
    return readdirSync(dir).filter(n => n.endsWith('.m4s')).map(n => {
      const path = join(dir, n)
      const st = statSync(path)
      return { path, mtimeMs: st.mtimeMs, size: st.size }
    })
  } catch { return [] }
}
```

`server/src/index.ts` (completo — importa además `pickPrunable`/`segmentFilesWithStats` de `./media/cachePrune.js`):
```ts
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { buildApp } from './app.js'
import { cacheDir, loadConfig } from './config.js'
import { scanLibrary } from './library/scanner.js'
import { RoomManager } from './rooms/roomManager.js'
import { TranscodeSession } from './media/transcoder.js'
import { detectEncoder } from './media/hwaccel.js'
import { Tunnel } from './tunnel/cloudflared.js'

const config = loadConfig()
rmSync(cacheDir(), { recursive: true, force: true })
mkdirSync(cacheDir(), { recursive: true })

const encoder = await detectEncoder()
const rooms = new RoomManager({
  createSession: (item, info, segments, roomDir, forceTranscode) => new TranscodeSession({
    input: item.path, mode: !forceTranscode && info.videoCodec === 'h264' ? 'copy' : 'transcode',
    encoder, segments, audioCount: info.audio.length, outDir: roomDir,
  }),
})

setInterval(() => {
  const limit = config.cacheLimitGB * 2 ** 30
  const files = rooms.all().flatMap(r => segmentFilesWithStats(r.roomDir))
  for (const p of pickPrunable(files, limit)) rmSync(p, { force: true })
}, 60_000).unref()

const adminToken = randomBytes(12).toString('base64url')
const tunnel = new Tunnel(config.port)
const app = await buildApp({ config, library: () => scanLibrary(config.mediaFolders), rooms, adminToken, tunnel })

await app.listen({ port: config.port, host: '0.0.0.0' })
tunnel.onUrl(u => console.log(`\n🌍 URL pública: ${u}\n`))
tunnel.onDown(() => console.log('⚠️  Túnel caído, reintentando…'))
tunnel.start()

const adminUrl = `http://localhost:${config.port}/?key=${adminToken}`
console.log(`🎬 jbg-watchparty — panel: ${adminUrl}`)
if (process.platform === 'darwin') spawn('open', [adminUrl])
else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', adminUrl])

process.on('SIGINT', async () => {
  for (const r of rooms.all()) await rooms.close(r.token)
  tunnel.stop()
  await app.close()
  process.exit(0)
})
```

- [ ] **Step 4: Run todos los tests + `npx tsc --noEmit`** — Expected: PASS/limpio.
- [ ] **Step 5: Smoke manual:** `npm start -w server` con una carpeta configurada a mano en el config.json → imprime panel y URL pública.
- [ ] **Step 6: Commit** — `git commit -am "feat: server entry wiring with tunnel, cache cleanup and browser open"`

---

### Task 16: Web — scaffold, biblioteca y creación de sala

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/vitest.config.ts`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/pages/Library.tsx`, `web/src/pages/Room.tsx` (placeholder con el token), `web/src/theme.css`
- Test: `web/test/api.test.ts`

**Interfaces:**
- Consumes: rutas REST de Tasks 11/15.
- Produces:
  - `web/src/api.ts`: `getLibrary(): Promise<LibraryItem[]>`, `createRoom(itemId: string): Promise<{ token: string }>`, `getRoom(token: string): Promise<RoomInfo>`, `getStatus(): Promise<{ tunnelUrl: string | null }>`, `searchGifs(q: string, room: string): Promise<{ results: GifResult[] } | { gifsDisabled: true }>` — tipos duplicados localmente en `web/src/types.ts` (espejo de los del server; sin dependencia cruzada entre workspaces en v1).
  - `App.tsx`: si `location.pathname` empieza por `/room/` → `<Room token=…/>`; si no → `<Library/>`.
  - `Library.tsx`: lista agrupada por `folderName`, botón por item → `createRoom` → al recibir token, muestra el enlace compartible `${tunnelUrl}/room/${token}` con botón copiar y navega a `/room/<token>`.

- [ ] **Step 1: Scaffold**

`web/package.json`:
```json
{
  "name": "@jbg/web",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest run" },
  "dependencies": { "hls.js": "^1.5.13", "react": "^18.3.1", "react-dom": "^18.3.1" },
  "devDependencies": {
    "@types/react": "^18.3.3", "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1", "typescript": "^5.5.3", "vite": "^5.3.3", "vitest": "^2.0.3"
  }
}
```

`web/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8400',
      '/stream': 'http://localhost:8400',
      '/ws': { target: 'ws://localhost:8400', ws: true },
    },
  },
})
```

`web/tsconfig.json`: `{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "jsx": "react-jsx", "strict": true, "skipLibCheck": true, "lib": ["ES2022", "DOM"] }, "include": ["src", "test"] }`

`web/index.html`: html mínimo con `<div id="root">`, `<script type="module" src="/src/main.tsx">`, `<link rel="stylesheet" href="/src/theme.css">`, `<title>jbg-watchparty</title>`.

`web/src/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client'
import { App } from './App'
createRoot(document.getElementById('root')!).render(<App />)
```

- [ ] **Step 2: Failing test de api.ts**

`web/test/api.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { getLibrary, createRoom } from '../src/api'

describe('api client', () => {
  it('getLibrary GETs /api/library', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'))
    await getLibrary()
    expect(spy).toHaveBeenCalledWith('/api/library')
    spy.mockRestore()
  })
  it('createRoom POSTs itemId', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"token":"t"}'))
    const r = await createRoom('abc')
    expect(r.token).toBe('t')
    expect(spy.mock.calls[0][0]).toBe('/api/rooms')
    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)).toEqual({ itemId: 'abc' })
    spy.mockRestore()
  })
})
```

`web/vitest.config.ts`: `import { defineConfig } from 'vitest/config'; export default defineConfig({ test: {} })`

- [ ] **Step 3: Run `npx vitest run` en web/** — Expected: FAIL.
- [ ] **Step 4: Implementación de api.ts, types.ts, App, Library, Room placeholder, theme.css**

`web/src/api.ts`:
```ts
import type { LibraryItem, RoomInfo, GifResult } from './types'

const json = async <T>(r: Response): Promise<T> => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

export const getLibrary = () => fetch('/api/library').then(r => json<LibraryItem[]>(r))
export const createRoom = (itemId: string) =>
  fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId }) }).then(r => json<{ token: string }>(r))
export const getRoom = (token: string) => fetch(`/api/rooms/${token}`).then(r => json<RoomInfo>(r))
export const getStatus = () => fetch('/api/status').then(r => json<{ tunnelUrl: string | null }>(r))
export const searchGifs = (q: string, room: string) =>
  fetch(`/api/gifs/search?q=${encodeURIComponent(q)}&room=${room}`).then(r => r.status === 404 ? { gifsDisabled: true as const } : json<{ results: GifResult[] }>(r))
```

`web/src/types.ts` — espejo de: `LibraryItem` (Task 4), `AudioTrack`/`SubtitleOption` (Tasks 5/9), `PlaybackState` (Task 10), `Participant`/`ChatEntry`/`ServerMsg`/`ClientMsg` (Task 12), `GifResult` (Task 13), más `interface RoomInfo { title: string; durationSec: number; audio: AudioTrack[]; subtitles: SubtitleOption[]; error: string[] | null }`. Copiar las definiciones literales de las tasks correspondientes.

`web/src/App.tsx`:
```tsx
import { Library } from './pages/Library'
import { Room } from './pages/Room'

export function App() {
  const m = location.pathname.match(/^\/room\/([\w-]+)/)
  return m ? <Room token={m[1]} /> : <Library />
}
```

`web/src/pages/Library.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { createRoom, getLibrary, getStatus } from '../api'
import type { LibraryItem } from '../types'

export function Library() {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = async (item: LibraryItem) => {
    const { token } = await createRoom(item.id)
    const { tunnelUrl } = await getStatus()
    const url = `${tunnelUrl ?? location.origin}/room/${token}`
    await navigator.clipboard.writeText(url).catch(() => {})
    location.pathname = `/room/${token}`
  }

  useEffect(() => { getLibrary().then(setItems).catch(e => setError(String(e))) }, [])

  if (error) return <main className="page"><p>Solo el host puede ver la biblioteca. ({error})</p></main>
  if (!items) return <main className="page"><p>Cargando…</p></main>
  const groups = [...new Set(items.map(i => i.folderName))]
  return (
    <main className="page">
      <h1>🎬 Biblioteca</h1>
      {groups.map(g => (
        <section key={g}>
          <h2>{g}</h2>
          <ul>{items.filter(i => i.folderName === g).map(i => (
            <li key={i.id}><button onClick={() => start(i)}>{i.title}</button></li>
          ))}</ul>
        </section>
      ))}
    </main>
  )
}
```

Nota: el flujo de compartir se pule en Task 18 (el enlace se muestra también dentro de la sala); aquí basta copiar al portapapeles y navegar.

`web/src/pages/Room.tsx` (placeholder de esta task):
```tsx
export function Room({ token }: { token: string }) {
  return <main className="page"><h1>Sala {token}</h1></main>
}
```

`web/src/theme.css` — base oscura: fondo `#0f1115`, texto `#e8e8e8`, acento `#7c5cff`, `*{box-sizing:border-box}`, `body{margin:0;font-family:system-ui}`, `.page{max-width:960px;margin:0 auto;padding:2rem}`, botones con hover. (El layout fino de la sala llega en Tasks 17-18.)

- [ ] **Step 5: Run web tests + `npm run build -w web`** — Expected: PASS y build OK.
- [ ] **Step 6: Smoke manual:** servidor arrancado + `npm run dev -w web` → la biblioteca lista el fixture/carpeta configurada, crear sala navega a `/room/<token>`.
- [ ] **Step 7: Commit** — `git commit -am "feat: web scaffold with library page and room creation"`

---

### Task 17: Web — reproductor, pistas y corrección de deriva

**Files:**
- Create: `web/src/sync/driftControl.ts`, `web/src/ws.ts`, `web/src/player/Player.tsx`
- Modify: `web/src/pages/Room.tsx`
- Test: `web/test/driftControl.test.ts`, `web/test/backoff.test.ts`

**Interfaces:**
- Consumes: `getRoom` (Task 16), mensajes WS (Task 12 vía `types.ts`), `/stream/:token/master.m3u8` (Task 11).
- Produces:
  - `type Correction = { kind: 'none' } | { kind: 'rate'; rate: number } | { kind: 'seek'; to: number }`
  - `computeCorrection(targetSec: number, actualSec: number): Correction` — |Δ|<0,3 → none; ≤2 → rate 1.05/0.95 (adelantar si vamos por detrás); >2 → seek.
  - `targetPosition(state: PlaybackState, serverNow: number, receivedAt: number, now: number): number` — `positionAt` compensando el desfase de reloj: `positionAt(state, serverNow + (now - receivedAt))` (reimplementar `positionAt` en este módulo, es una línea).
  - `nextDelay(attempt: number): number` — `min(500 * 2^attempt, 8000)`.
  - `connectRoom(token: string, name: string, onMsg: (m: ServerMsg) => void): { send: (m: ClientMsg) => void; close: () => void }` en `web/src/ws.ts` — reconecta con `nextDelay`, re-envía `join` al reconectar; `ws(s)://` según `location.protocol`.
  - `Player.tsx`: `<Player token={token} info={roomInfo} send={send} lastState={{state, serverNow, receivedAt}} />` — hls.js sobre `<video>` con `src` `/stream/<token>/master.m3u8`; selector de audio (`hls.audioTracks` → `hls.audioTrack = i`); selector de subtítulos (elementos `<track kind="subtitles" src="/stream/<token>/sub_<id>.vtt">`, activación vía `textTracks[i].mode`); barra de controles (play/pause/seek sobre barra de progreso) que **solo envía** acciones WS (`{t:'play'}` etc.) — el estado local nunca manda; tick de 500 ms aplica `computeCorrection` (rate → `video.playbackRate`; seek → `video.currentTime`); eventos `waiting`/`playing` del vídeo → `{t:'buffering', value}`.

- [ ] **Step 1: Failing tests puros**

`web/test/driftControl.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { computeCorrection, targetPosition } from '../src/sync/driftControl'

describe('computeCorrection', () => {
  it.each([
    [100, 100.1, 'none'], [100, 99.5, 'rate'], [100, 101.5, 'rate'], [100, 90, 'seek'],
  ])('target=%d actual=%d -> %s', (t, a, kind) => {
    expect(computeCorrection(t, a).kind).toBe(kind)
  })
  it('speeds up when behind, slows when ahead', () => {
    expect(computeCorrection(100, 99)).toEqual({ kind: 'rate', rate: 1.05 })
    expect(computeCorrection(100, 101)).toEqual({ kind: 'rate', rate: 0.95 })
  })
  it('seek carries target', () => {
    expect(computeCorrection(50, 10)).toEqual({ kind: 'seek', to: 50 })
  })
})

describe('targetPosition', () => {
  it('compensates clock offset while playing', () => {
    const state = { paused: false, positionBase: 100, updatedAt: 1000 }
    expect(targetPosition(state, 1000, 5000, 8000)).toBeCloseTo(103)
  })
  it('frozen when paused', () => {
    const state = { paused: true, positionBase: 100, updatedAt: 1000 }
    expect(targetPosition(state, 1000, 5000, 99000)).toBe(100)
  })
})
```

`web/test/backoff.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { nextDelay } from '../src/ws'

describe('nextDelay', () => {
  it('doubles from 500ms capped at 8s', () => {
    expect([0, 1, 2, 3, 4, 5].map(nextDelay)).toEqual([500, 1000, 2000, 4000, 8000, 8000])
  })
})
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implementar `driftControl.ts` y `ws.ts`**

`web/src/sync/driftControl.ts`:
```ts
import type { PlaybackState } from '../types'

export type Correction = { kind: 'none' } | { kind: 'rate'; rate: number } | { kind: 'seek'; to: number }

export function computeCorrection(targetSec: number, actualSec: number): Correction {
  const d = targetSec - actualSec
  const abs = Math.abs(d)
  if (abs < 0.3) return { kind: 'none' }
  if (abs <= 2) return { kind: 'rate', rate: d > 0 ? 1.05 : 0.95 }
  return { kind: 'seek', to: targetSec }
}

const positionAt = (s: PlaybackState, now: number) =>
  s.paused ? s.positionBase : s.positionBase + (now - s.updatedAt) / 1000

export function targetPosition(state: PlaybackState, serverNow: number, receivedAt: number, now: number): number {
  return positionAt(state, serverNow + (now - receivedAt))
}
```

`web/src/ws.ts`:
```ts
import type { ClientMsg, ServerMsg } from './types'

export const nextDelay = (attempt: number) => Math.min(500 * 2 ** attempt, 8000)

export function connectRoom(token: string, name: string, onMsg: (m: ServerMsg) => void) {
  let ws: WebSocket | null = null
  let closed = false
  let attempt = 0

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws/${token}`)
    ws.onopen = () => { attempt = 0; ws!.send(JSON.stringify({ t: 'join', name })) }
    ws.onmessage = e => onMsg(JSON.parse(e.data))
    ws.onclose = () => { if (!closed) setTimeout(open, nextDelay(attempt++)) }
  }
  open()

  return {
    send: (m: ClientMsg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) },
    close: () => { closed = true; ws?.close() },
  }
}
```

- [ ] **Step 4: Run tests** — Expected: PASS.
- [ ] **Step 5: Implementar `Player.tsx` y `Room.tsx`**

`web/src/player/Player.tsx` (núcleo — el JSX de controles puede crecer, la lógica es esta):
```tsx
import Hls from 'hls.js'
import { useEffect, useRef, useState } from 'react'
import type { ClientMsg, PlaybackState, RoomInfo } from '../types'
import { computeCorrection, targetPosition } from '../sync/driftControl'

export interface LastState { state: PlaybackState; serverNow: number; receivedAt: number }

export function Player({ token, info, send, lastState }: {
  token: string; info: RoomInfo; send: (m: ClientMsg) => void; lastState: LastState | null
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const [audioTracks, setAudioTracks] = useState<{ id: number; name: string }[]>([])
  const [sub, setSub] = useState<number>(-1)

  useEffect(() => {
    const video = videoRef.current!
    const hls = new Hls()
    hlsRef.current = hls
    hls.loadSource(`/stream/${token}/master.m3u8`)
    hls.attachMedia(video)
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () =>
      setAudioTracks(hls.audioTracks.map((t, id) => ({ id, name: t.name }))))
    const onWaiting = () => send({ t: 'buffering', value: true })
    const onPlaying = () => send({ t: 'buffering', value: false })
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    return () => { hls.destroy(); video.removeEventListener('waiting', onWaiting); video.removeEventListener('playing', onPlaying) }
  }, [token])

  useEffect(() => {
    const id = setInterval(() => {
      const video = videoRef.current
      if (!video || !lastState) return
      const target = targetPosition(lastState.state, lastState.serverNow, lastState.receivedAt, Date.now())
      if (lastState.state.paused) {
        if (!video.paused) video.pause()
        if (Math.abs(video.currentTime - target) > 0.5) video.currentTime = target
        return
      }
      if (video.paused) void video.play().catch(() => {})
      const c = computeCorrection(target, video.currentTime)
      if (c.kind === 'rate') video.playbackRate = c.rate
      else if (c.kind === 'seek') { video.currentTime = c.to; video.playbackRate = 1 }
      else video.playbackRate = 1
    }, 500)
    return () => clearInterval(id)
  }, [lastState])

  useEffect(() => {
    const tracks = videoRef.current?.textTracks ?? []
    for (let i = 0; i < tracks.length; i++) tracks[i].mode = i === sub ? 'showing' : 'hidden'
  }, [sub])

  const seekTo = (pos: number) => send({ t: 'seek', position: pos })

  return (
    <div className="player">
      <video ref={videoRef} playsInline>
        {info.subtitles.map(s => (
          <track key={s.id} kind="subtitles" label={s.label} srcLang={s.lang} src={`/stream/${token}/sub_${s.id}.vtt`} />
        ))}
      </video>
      <div className="controls">
        <button onClick={() => send({ t: lastState?.state.paused ? 'play' : 'pause' })}>
          {lastState?.state.paused ? '▶️' : '⏸'}
        </button>
        <input type="range" min={0} max={info.durationSec} step={1}
          value={lastState ? Math.min(info.durationSec, targetPosition(lastState.state, lastState.serverNow, lastState.receivedAt, Date.now())) : 0}
          onChange={e => seekTo(Number(e.target.value))} />
        <select onChange={e => { if (hlsRef.current) hlsRef.current.audioTrack = Number(e.target.value) }}>
          {audioTracks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={sub} onChange={e => setSub(Number(e.target.value))}>
          <option value={-1}>Sin subtítulos</option>
          {info.subtitles.map((s, i) => <option key={s.id} value={i}>{s.label}</option>)}
        </select>
      </div>
    </div>
  )
}
```

Nota sobre la barra de progreso: el tick de deriva no re-renderiza (solo toca refs), así que añade en `Player` un re-render periódico de 1 s (`const [, tick] = useReducer(x => x + 1, 0)` + `setInterval(tick, 1000)` en un effect) para que el slider avance.

`Room.tsx` pasa a: pedir nombre si no está en `localStorage['jbg-name']` (input + botón), `getRoom(token)` para `RoomInfo` (si `error` no es null → pantalla de error con el log y botón «Reintentar» que hace `fetch('/api/rooms/' + token + '/retry', { method: 'POST' })` y recarga — el servidor fuerza transcodificación en el reintento), `connectRoom` guardando en estado `lastState` (de `welcome`/`state`, con `receivedAt: Date.now()`), y render de `<Player>` (chat llega en Task 18). Si `getRoom` da 404 → «Sala no encontrada». Además, si `getStatus()` responde (solo el host — a los invitados les da 401 y se omite), poll cada 30 s: con `tunnelUrl === null` muestra un banner «Túnel caído, relanzando…» hasta que vuelva.

- [ ] **Step 6: `npm run build -w web` + smoke manual** con un MKV real: reproducir, cambiar pista de audio en una pestaña y comprobar que la otra no cambia; pausar en una → se pausa la otra.
- [ ] **Step 7: Commit** — `git commit -am "feat: synced hls player with per-viewer audio and subtitle selection"`

---

### Task 18: Web — chat, GIFs, reacciones y presencia

**Files:**
- Create: `web/src/chat/ChatPanel.tsx`, `web/src/chat/GifPicker.tsx`, `web/src/chat/ReactionsBar.tsx`, `web/src/chat/ReactionOverlay.tsx`, `web/src/chat/chatStore.ts`
- Modify: `web/src/pages/Room.tsx`, `web/src/theme.css`
- Test: `web/test/chatStore.test.ts`

**Interfaces:**
- Consumes: `ServerMsg`/`ChatEntry`/`Participant` (types.ts), `send` de `connectRoom`, `searchGifs` (Task 16).
- Produces:
  - `interface ChatState { entries: ChatEntry[]; participants: Participant[]; buffering: string[]; reactions: { id: number; emoji: string }[] }`
  - `chatReducer(s: ChatState, m: ServerMsg): ChatState` — puro: `welcome` (history+participants), `chat` (append, cap 500), `presence`, `buffering` (añade/quita nombre), `reaction` (append con id incremental; el componente las retira tras animarse — el reducer solo añade, `dropReaction(s, id)` las quita).
  - `ChatPanel` — lista de entries (texto con color del autor, GIFs como `<img>`, system en cursiva gris), input con Enter para enviar, botón GIF que abre `GifPicker` (input búsqueda con debounce 300 ms → `searchGifs`, grid de previews, click → `send({t:'gif', url})`; si `gifsDisabled` el botón GIF no se muestra), lista de participantes con puntos de color, «X está cargando…» cuando `buffering` no está vacío.
  - `ReactionsBar` — botones `['😂','❤️','😱','🔥','👏','😭']` → `send({t:'reaction', emoji})`.
  - `ReactionOverlay` — absoluto sobre el vídeo; cada reacción entra con `left` aleatorio y anima hacia arriba con fade (CSS `@keyframes float-up`, 2.5 s, `transform: translateY(-40vh)`), al terminar `dropReaction`.

- [ ] **Step 1: Failing test del reducer**

`web/test/chatStore.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { chatReducer, initialChat, dropReaction } from '../src/chat/chatStore'

const p = { id: 'u1', name: 'Ana', color: '#f00' }
const entry = (text: string) => ({ id: text, from: p, kind: 'text' as const, text, at: 1 })

describe('chatReducer', () => {
  it('welcome seeds history and participants', () => {
    const s = chatReducer(initialChat, { t: 'welcome', self: p, participants: [p], state: { paused: true, positionBase: 0, updatedAt: 0 }, serverNow: 0, history: [entry('hola')] } as any)
    expect(s.entries).toHaveLength(1)
    expect(s.participants).toEqual([p])
  })
  it('chat appends capped at 500', () => {
    let s = { ...initialChat, entries: Array.from({ length: 500 }, (_, i) => entry(String(i))) }
    s = chatReducer(s, { t: 'chat', entry: entry('nuevo') } as any)
    expect(s.entries).toHaveLength(500)
    expect(s.entries.at(-1)!.text).toBe('nuevo')
  })
  it('buffering adds and removes names', () => {
    let s = chatReducer(initialChat, { t: 'buffering', name: 'Ana', value: true } as any)
    expect(s.buffering).toEqual(['Ana'])
    s = chatReducer(s, { t: 'buffering', name: 'Ana', value: false } as any)
    expect(s.buffering).toEqual([])
  })
  it('reactions get incremental ids and can be dropped', () => {
    let s = chatReducer(initialChat, { t: 'reaction', emoji: '🔥', from: 'Ana' } as any)
    s = chatReducer(s, { t: 'reaction', emoji: '❤️', from: 'Ana' } as any)
    expect(s.reactions.map(r => r.id)).toEqual([1, 2])
    expect(dropReaction(s, 1).reactions.map(r => r.id)).toEqual([2])
  })
})
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implementación**

`web/src/chat/chatStore.ts`:
```ts
import type { ChatEntry, Participant, ServerMsg } from '../types'

export interface ChatState {
  entries: ChatEntry[]; participants: Participant[]
  buffering: string[]; reactions: { id: number; emoji: string }[]
}

export const initialChat: ChatState = { entries: [], participants: [], buffering: [], reactions: [] }
let reactionId = 0

export function chatReducer(s: ChatState, m: ServerMsg): ChatState {
  switch (m.t) {
    case 'welcome': return { ...s, entries: m.history, participants: m.participants }
    case 'chat': return { ...s, entries: [...s.entries, m.entry].slice(-500) }
    case 'presence': return { ...s, participants: m.participants }
    case 'buffering': return { ...s, buffering: m.value ? [...new Set([...s.buffering, m.name])] : s.buffering.filter(n => n !== m.name) }
    case 'reaction': return { ...s, reactions: [...s.reactions, { id: ++reactionId, emoji: m.emoji }] }
    default: return s
  }
}

export const dropReaction = (s: ChatState, id: number): ChatState =>
  ({ ...s, reactions: s.reactions.filter(r => r.id !== id) })
```

(Para el test de ids incrementales deterministas, exportar también `resetReactionIds()` que ponga `reactionId = 0` y llamarlo en `beforeEach` si hace falta.)

Componentes: seguir las interfaces del bloque de arriba. `Room.tsx` queda con layout `display:grid; grid-template-columns: 1fr 320px` — vídeo+overlay+reactions bar a la izquierda, `ChatPanel` a la derecha; en móvil (media query < 800px) chat debajo. El estado del chat vive en `Room` (`useReducer(chatReducer, initialChat)`) y el handler de `connectRoom` hace dispatch de cada `ServerMsg` **y además** actualiza `lastState` cuando `m.t === 'welcome' | 'state'`.

CSS del overlay en `theme.css`:
```css
.reaction-overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.reaction-overlay span { position: absolute; bottom: 0; font-size: 2.5rem; animation: float-up 2.5s ease-out forwards; }
@keyframes float-up { to { transform: translateY(-40vh); opacity: 0; } }
```

- [ ] **Step 4: Run web tests + build** — Expected: PASS.
- [ ] **Step 5: Smoke manual:** dos pestañas — chat bidireccional, GIF picker (con API key en config), reacciones flotando en ambas, «está cargando…» al throttlear red en devtools.
- [ ] **Step 6: Commit** — `git commit -am "feat: chat panel with gifs, reactions overlay and presence"`

---

### Task 19: Checklist E2E, README y verificación final

**Files:**
- Create: `docs/e2e-checklist.md`, `README.md`

**Interfaces:** ninguna nueva.

- [ ] **Step 1: Escribir `docs/e2e-checklist.md`**

```markdown
# Checklist E2E manual — jbg-watchparty

Preparación: `npm install && npm start`, config con una carpeta que tenga
un MKV multi-audio real y un .srt externo. Anota la URL pública del túnel.

## Básico
- [ ] La biblioteca lista los vídeos agrupados por carpeta con títulos limpios
- [ ] Crear sala navega a /room/<token> y copia el enlace público
- [ ] El enlace público abre la sala desde OTRA red (datos móviles)
- [ ] El invitado entra con su nombre y ve el vídeo en < 15 s

## Sync
- [ ] Pausa desde el host → pausa en el invitado en < 1 s, con mensaje de sistema
- [ ] Play desde el invitado → reanuda en el host
- [ ] Seek a mitad de peli → ambos saltan; vídeo arranca en < 10 s
- [ ] Seek hacia atrás a zona ya vista → arranque casi instantáneo (caché)
- [ ] Tras 10 min reproduciendo, deriva entre pantallas imperceptible (< 0,5 s)

## Pistas
- [ ] Cambiar audio en el invitado NO cambia el audio del host
- [ ] Cada selector de subtítulos funciona por espectador (incrustado y .srt externo)
- [ ] Archivo HEVC → transcodifica y reproduce (CPU/GPU visible en monitor)

## Chat
- [ ] Mensajes bidireccionales con colores por usuario
- [ ] GIFs: búsqueda y envío (con API key); sin API key el botón no aparece
- [ ] Reacciones flotan sobre el vídeo en ambas pantallas
- [ ] Recargar la página del invitado → reconecta, historial y posición intactos

## Errores
- [ ] Archivo corrupto → la sala muestra error con log y botón reintentar
- [ ] Matar cloudflared a mano → se relanza y loguea nueva URL
- [ ] Cerrar sala (DELETE) → caché de la sala borrada
```

- [ ] **Step 2: Escribir `README.md`** — qué es, requisitos (Node ≥ 20), instalación (`npm install && npm start`), dónde vive `config.json` (rutas macOS/Windows) y sus campos (con ejemplo JSON completo), cómo conseguir API key de Klipy (klipy.com/developers, opcional), cómo compartir el enlace, limitaciones v1 (copiadas de «Fuera de alcance» del spec), sección desarrollo (`npm run dev -w web` + `npm start -w server`, `npm test`).
- [ ] **Step 3: Verificación final:** `npm test` (raíz) verde, `npx tsc --noEmit` en server limpio, `npm run build -w web` OK, y pasar el checklist E2E completo marcando cada casilla.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs: e2e checklist and readme"`

---

## Orden y dependencias

1→2→3→4 (biblioteca) y 5→6→7→8→9 (media) son dos cadenas casi independientes tras la 2; 10 es independiente; 11 necesita 4+6+8+9+10; 12 necesita 11; 13 y 14 solo necesitan 11 y 2 respectivamente; 15 necesita 11-14; 16 necesita 15; 17→18 necesitan 16; 19 al final.
