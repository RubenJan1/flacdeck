import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import type { BinaryStatus } from '../../shared/types'

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

const YTDLP_ASSET: Record<string, string> = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: 'yt-dlp_linux'
}

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

/** Haalt de nieuwste yt-dlp op van GitHub en zet 'm in userData/bin. */
export async function installYtdlp(onProgress?: (pct: number) => void): Promise<string> {
  const asset = YTDLP_ASSET[process.platform]
  if (!asset) throw new Error(`Platform ${process.platform} wordt niet ondersteund`)
  await fsp.mkdir(ytdlpDir(), { recursive: true })
  const dest = ytdlpPath()
  await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, dest, onProgress)
  return dest
}

/** Zorgt dat yt-dlp bestaat; downloadt 'm als dat nog niet zo is. */
export async function ensureYtdlp(onProgress?: (pct: number) => void): Promise<string> {
  if (ytdlpInstalled()) return ytdlpPath()
  return installYtdlp(onProgress)
}

async function version(bin: string, args: string[], strip?: RegExp): Promise<{ ok: boolean; version: string }> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 15000, windowsHide: true })
    const first = stdout.split('\n')[0].trim()
    return { ok: true, version: strip ? (first.match(strip)?.[1] ?? first) : first }
  } catch {
    return { ok: false, version: '' }
  }
}

export async function binaryStatus(): Promise<BinaryStatus> {
  const [ff, fp, yt] = await Promise.all([
    version(ffmpegPath(), ['-version'], /ffmpeg version (\S+)/),
    version(ffprobePath(), ['-version'], /ffprobe version (\S+)/),
    ytdlpInstalled() ? version(ytdlpPath(), ['--version']) : Promise.resolve({ ok: false, version: '' })
  ])
  return {
    ffmpeg: { path: ffmpegPath(), ...ff },
    ffprobe: { path: ffprobePath(), ...fp },
    ytdlp: { path: ytdlpPath(), ...yt }
  }
}

/** yt-dlp updaten door simpelweg de nieuwste release er overheen te zetten. */
export async function updateYtdlp(onProgress?: (pct: number) => void): Promise<string> {
  return installYtdlp(onProgress)
}
