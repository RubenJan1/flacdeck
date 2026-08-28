import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import type { BinaryInfo, BinaryStatus } from '../../shared/types'

const execFileAsync = promisify(execFile)

/**
 * In een gepackte app zitten de binaries in app.asar.unpacked, niet in de asar zelf.
 * ffmpeg-static geeft het asar-pad terug, dus dat moeten we omschrijven.
 */
function unpacked(p: string): string {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`).replace('app.asar/', 'app.asar.unpacked/')
}

function resolveStatic(mod: string, pick: (m: unknown) => string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require(mod)
    const raw = pick(m)
    return raw ? unpacked(raw) : ''
  } catch {
    return ''
  }
}

export const ffmpegPath = (): string => {
  const fromEnv = process.env.FLACDECK_FFMPEG
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const p = resolveStatic('ffmpeg-static', (m) => (typeof m === 'string' ? m : (m as { default?: string })?.default ?? ''))
  return p && fs.existsSync(p) ? p : 'ffmpeg'
}

export const ffprobePath = (): string => {
  const fromEnv = process.env.FLACDECK_FFPROBE
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const p = resolveStatic('ffprobe-static', (m) => (m as { path?: string })?.path ?? '')
  return p && fs.existsSync(p) ? p : 'ffprobe'
}

/* ------------------------------- yt-dlp ---------------------------------- */

/**
 * Per platform de releasebestanden, op volgorde van voorkeur. yt-dlp_macos is
 * gebouwd voor macOS 12 en hoger; op oudere systemen start die niet en valt de
 * installatie terug op de legacy-build.
 */
const YTDLP_ASSETS: Record<string, string[]> = {
  win32: ['yt-dlp.exe'],
  darwin: ['yt-dlp_macos', 'yt-dlp_macos_legacy'],
  linux: ['yt-dlp_linux']
}

/** yt-dlp is een PyInstaller-bundel: de eerste start pakt zichzelf uit en dat duurt. */
const PROBE_TIMEOUT = 120000

export function ytdlpDir(): string {
  return path.join(app.getPath('userData'), 'bin')
}

export function ytdlpPath(): string {
  const override = process.env.FLACDECK_YTDLP
  if (override && fs.existsSync(override)) return override
  const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  return path.join(ytdlpDir(), name)
}

export function ytdlpInstalled(): boolean {
  return fs.existsSync(ytdlpPath())
}

/* ------------------------ onthouden wat al werkte ------------------------- */

interface Stamp {
  path: string
  size: number
  mtimeMs: number
  version: string
}

function stampFile(): string {
  return path.join(ytdlpDir(), 'yt-dlp.json')
}

function signature(bin: string): Omit<Stamp, 'version'> | null {
  try {
    const s = fs.statSync(bin)
    return { path: bin, size: s.size, mtimeMs: Math.round(s.mtimeMs) }
  } catch {
    return null
  }
}

function readStamp(): Stamp | null {
  try {
    const raw = JSON.parse(fs.readFileSync(stampFile(), 'utf8')) as Stamp
    return raw && typeof raw.version === 'string' ? raw : null
  } catch {
    return null
  }
}

function writeStamp(bin: string, version: string): void {
  const sig = signature(bin)
  if (!sig) return
  try {
    fs.writeFileSync(stampFile(), JSON.stringify({ ...sig, version }, null, 2))
  } catch {
    /* niet erg: dan meten we het de volgende keer opnieuw */
  }
}

/** De onthouden versie, maar alleen als het bestand nog exact hetzelfde is. */
function stampedVersion(bin: string): string {
  const stamp = readStamp()
  const sig = signature(bin)
  if (!stamp || !sig) return ''
  return stamp.path === sig.path && stamp.size === sig.size && stamp.mtimeMs === sig.mtimeMs
    ? stamp.version
    : ''
}

/* ------------------------------- foutuitleg ------------------------------- */

function describe(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
  const detail = (e?.stderr ?? '').trim().split('\n').slice(0, 3).join(' ').trim()
  const raw = detail || e?.message || String(err)

  if (e?.killed === true || e?.code === 'ETIMEDOUT') {
    return 'yt-dlp reageerde niet binnen twee minuten. Probeer het opnieuw; de allereerste start duurt op sommige machines lang.'
  }
  if (e?.code === 'ENOENT') return 'Het bestand yt-dlp staat niet op de verwachte plek.'
  if (e?.code === 'EACCES') return 'yt-dlp mag niet uitgevoerd worden (het bestand heeft geen x-rechten).'
  if (/bad cpu type|cannot execute binary|exec format/i.test(raw)) {
    return `Deze yt-dlp past niet bij dit systeem (verkeerde processor of te oude macOS). ${raw}`
  }
  if (/killed|damaged|cannot be opened/i.test(raw)) {
    return `macOS blokkeert yt-dlp. ${raw}`
  }
  return raw
}

/* --------------------------------- meten ---------------------------------- */

async function version(bin: string, args: string[], strip?: RegExp): Promise<BinaryInfo> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 15000, windowsHide: true })
    const first = stdout.split('\n')[0].trim()
    return { path: bin, ok: true, version: strip ? (first.match(strip)?.[1] ?? first) : first, error: '' }
  } catch (err) {
    return { path: bin, ok: false, version: '', error: describe(err) }
  }
}

/** Draait yt-dlp --version, met een ruime timeout voor die eerste trage start. */
async function runYtdlpVersion(bin: string): Promise<string> {
  const { stdout } = await execFileAsync(bin, ['--version'], {
    timeout: PROBE_TIMEOUT,
    windowsHide: true
  })
  return stdout.split('\n')[0].trim()
}

/**
 * Status van yt-dlp. Is precies dit bestand eerder al eens gestart, dan geloven we
 * dat en starten we het niet opnieuw. Anders zou één trage of geblokkeerde start
 * het installatiescherm blijven terugbrengen terwijl yt-dlp er gewoon staat.
 */
export async function ytdlpStatus(): Promise<BinaryInfo> {
  const bin = ytdlpPath()
  if (!fs.existsSync(bin)) {
    return { path: bin, ok: false, version: '', error: 'yt-dlp is nog niet geïnstalleerd.' }
  }
  const known = stampedVersion(bin)
  if (known) return { path: bin, ok: true, version: known, error: '' }
  try {
    const v = await runYtdlpVersion(bin)
    writeStamp(bin, v)
    return { path: bin, ok: true, version: v, error: '' }
  } catch (err) {
    return { path: bin, ok: false, version: '', error: describe(err) }
  }
}

export async function binaryStatus(): Promise<BinaryStatus> {
  const [ffmpeg, ffprobe, ytdlp] = await Promise.all([
    version(ffmpegPath(), ['-version'], /ffmpeg version (\S+)/),
    version(ffprobePath(), ['-version'], /ffprobe version (\S+)/),
    ytdlpStatus()
  ])
  return { ffmpeg, ffprobe, ytdlp }
}

/* ------------------------------- downloaden ------------------------------- */

function download(url: string, dest: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (target: string, redirects = 0): void => {
      if (redirects > 6) return reject(new Error('Te veel redirects bij het downloaden van yt-dlp'))
      https
        .get(target, { headers: { 'User-Agent': 'FlacDeck' } }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            return request(new URL(res.headers.location, target).toString(), redirects + 1)
          }
          if (res.statusCode !== 200) {
            res.resume()
            return reject(new Error(`Download mislukt (HTTP ${res.statusCode})`))
          }
          const total = Number(res.headers['content-length'] || 0)
          let seen = 0
          const tmp = `${dest}.download`
          const file = fs.createWriteStream(tmp)
          res.on('data', (chunk: Buffer) => {
            seen += chunk.length
            if (total && onProgress) onProgress(Math.round((seen / total) * 100))
          })
          res.pipe(file)
          file.on('finish', () => {
            file.close(() => {
              try {
                fs.renameSync(tmp, dest)
                if (process.platform !== 'win32') fs.chmodSync(dest, 0o755)
                resolve()
              } catch (err) {
                reject(err as Error)
              }
            })
          })
          file.on('error', reject)
        })
        .on('error', reject)
    }
    request(url)
  })
}

/** macOS hangt een quarantainevlag aan gedownloade programma's; die halen we eraf. */
async function unquarantine(target: string): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    await execFileAsync('xattr', ['-d', 'com.apple.quarantine', target], { timeout: 10000 })
  } catch {
    /* vlag stond er niet, of xattr ontbreekt — allebei prima */
  }
}

/**
 * Haalt yt-dlp op van GitHub, zet 'm in userData/bin en controleert meteen of hij
 * ook echt start. Lukt dat niet, dan proberen we het volgende bestand voor dit
 * platform (op macOS de legacy-build) voordat we opgeven.
 */
export async function installYtdlp(onProgress?: (pct: number) => void): Promise<string> {
  const assets = YTDLP_ASSETS[process.platform]
  if (!assets?.length) throw new Error(`Platform ${process.platform} wordt niet ondersteund`)

  await fsp.mkdir(ytdlpDir(), { recursive: true })
  const dest = ytdlpPath()
  await fsp.rm(stampFile(), { force: true })

  const problems: string[] = []
  for (const asset of assets) {
    await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, dest, onProgress)
    await unquarantine(dest)
    try {
      writeStamp(dest, await runYtdlpVersion(dest))
      return dest
    } catch (err) {
      problems.push(`${asset}: ${describe(err)}`)
    }
  }
  throw new Error(`yt-dlp is gedownload maar start niet. ${problems.join(' — ')}`)
}

/** Zorgt dat yt-dlp bestaat; downloadt 'm als dat nog niet zo is. */
export async function ensureYtdlp(onProgress?: (pct: number) => void): Promise<string> {
  if (ytdlpInstalled()) return ytdlpPath()
  return installYtdlp(onProgress)
}

/** yt-dlp updaten door simpelweg de nieuwste release er overheen te zetten. */
export async function updateYtdlp(onProgress?: (pct: number) => void): Promise<string> {
  return installYtdlp(onProgress)
}
