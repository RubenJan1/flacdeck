import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import { ensureYtdlp, ffmpegPath } from './binaries'
import { segmentsFromChapters, segmentsFromText, splitArtistTitle, wholeSegment } from './tracklist'
import type { ProbeResult, Segment, Settings } from '../../shared/types'

export class CancelledError extends Error {
  constructor() {
    super('Geannuleerd')
    this.name = 'CancelledError'
  }
}

export interface RunHandle {
  child: ChildProcess
  done: Promise<{ stdout: string; stderr: string }>
}

function baseArgs(settings: Pick<Settings, 'cookiesFromBrowser' | 'proxy'>): string[] {
  const args = ['--no-warnings', '--no-color', '--ignore-config']
  if (settings.cookiesFromBrowser) args.push('--cookies-from-browser', settings.cookiesFromBrowser)
  if (settings.proxy) args.push('--proxy', settings.proxy)
  return args
}

function run(
  bin: string,
  args: string[],
  onLine?: (line: string, stream: 'out' | 'err') => void,
  signal?: AbortSignal
): RunHandle {
  const child = spawn(bin, args, { windowsHide: true })
  let stdout = ''
  let stderr = ''
  let outBuf = ''
  let errBuf = ''

  const pump = (chunk: string, buf: string): string => {
    const merged = buf + chunk
    const lines = merged.split(/\r?\n|\r/)
    const rest = lines.pop() ?? ''
    for (const l of lines) if (l.trim() && onLine) onLine(l, 'out')
    return rest
  }

  child.stdout?.on('data', (d: Buffer) => {
    const s = d.toString()
    stdout += s
    outBuf = pump(s, outBuf)
  })
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString()
    stderr += s
    errBuf = pump(s, errBuf)
  })

  const onAbort = (): void => {
    child.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const done = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new CancelledError())
      if (code === 0) return resolve({ stdout, stderr })
      const tail = stderr.trim().split('\n').slice(-4).join('\n')
      reject(new Error(tail || 'yt-dlp stopte met code ' + code))
    })
  })

  return { child, done }
}

/* -------------------------------- probe ---------------------------------- */

interface YtdlpJson {
  _type?: string
  id?: string
  title?: string
  uploader?: string
  channel?: string
  artist?: string
  track?: string
  album?: string
  release_year?: number
  upload_date?: string
  duration?: number
  is_live?: boolean
  was_live?: boolean
  live_status?: string
  thumbnail?: string
  description?: string
  webpage_url?: string
  chapters?: { title?: string; start_time?: number; end_time?: number }[]
  entries?: YtdlpJson[]
}

export async function probe(url: string, settings: Settings): Promise<ProbeResult> {
  const bin = await ensureYtdlp()
  const { stdout } = await run(bin, [...baseArgs(settings), '-J', '--no-playlist', url]).done
  const raw = JSON.parse(stdout) as YtdlpJson
  const info = raw._type === 'playlist' && raw.entries?.length ? raw.entries[0] : raw
  const playlistCount = raw._type === 'playlist' ? raw.entries?.length ?? 0 : 0

  const title = info.title ?? 'Onbekend'
  const uploader = info.uploader ?? info.channel ?? ''
  const duration = Number(info.duration ?? 0)
  const description = info.description ?? ''

  const chapters = (info.chapters ?? [])
    .map((c) => ({
      title: c.title ?? '',
      start: Number(c.start_time ?? 0),
      end: Number(c.end_time ?? 0)
    }))
    .filter((c) => Number.isFinite(c.start))

  // yt-dlp levert soms echte muziekmetadata (YouTube Music); die wint van raden.
  const guess =
    info.artist && info.track
      ? { artist: info.artist, title: info.track }
      : splitArtistTitle(title)
  if (!guess.artist) guess.artist = uploader

  const base = {
    artist: guess.artist,
    album: info.album ?? '',
    albumArtist: guess.artist,
    year: info.release_year ? String(info.release_year) : (info.upload_date ?? '').slice(0, 4)
  }

  let suggestedSegments: Segment[] = []
  let suggestionSource: ProbeResult['suggestionSource'] = 'none'
  if (chapters.length > 1) {
    suggestedSegments = segmentsFromChapters(chapters, base)
    suggestionSource = 'chapters'
  } else {
    const fromDesc = segmentsFromText(description, base, duration)
    if (fromDesc.length > 1) {
      suggestedSegments = fromDesc
      suggestionSource = 'description'
    }
  }
  if (!suggestedSegments.length) suggestedSegments = [wholeSegment(title, base)]

  return {
    id: info.id ?? '',
    url,
    webpageUrl: info.webpage_url ?? url,
    title,
    uploader,
    uploadDate: info.upload_date ?? '',
    duration,
    isLive: Boolean(info.is_live) || info.live_status === 'is_live',
    wasLive: Boolean(info.was_live) || info.live_status === 'was_live',
    thumbnail: info.thumbnail ?? '',
    description,
    chapters,
    guess,
    suggestedSegments,
    suggestionSource,
    playlistCount
  }
}

/** Alle video-URL's uit een playlist, in volgorde. */
export async function playlistUrls(url: string, settings: Settings): Promise<string[]> {
  const bin = await ensureYtdlp()
  const { stdout } = await run(bin, [
    ...baseArgs(settings),
    '--flat-playlist',
    '--print',
    '%(url)s',
    url
  ]).done
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('http'))
}

/* ------------------------------- download -------------------------------- */

const PCT = /\[download\]\s+(\d+(?:\.\d+)?)%/

export interface DownloadOptions {
  url: string
  outDir: string
  outBase: string
  isLive?: boolean
  settings: Settings
  onProgress?: (pct: number, note: string) => void
  signal?: AbortSignal
}

/**
 * Downloadt de complete audiostream en geeft het pad terug.
 *
 * Bewust niet met --download-sections: zonder --force-keyframes-at-cuts knipt
 * yt-dlp alleen op clustergrenzen (je krijgt dus meer dan je vroeg, met een
 * onbekende offset), en mét die vlag hercodeert het de audio opnieuw naar Opus.
 * Allebei onbruikbaar als je exact één track uit een set wilt. De hele bron
 * ophalen en zelf knippen kost wat meer bandbreedte — audio is klein — maar
 * levert een exacte, verliesvrije knip en één download voor alle segmenten.
 */
export async function downloadAudio(opts: DownloadOptions): Promise<string> {
  const bin = await ensureYtdlp()
  await fsp.mkdir(opts.outDir, { recursive: true })
  const template = path.join(opts.outDir, opts.outBase + '.%(ext)s')

  const args = [
    ...baseArgs(opts.settings),
    '-f',
    'bestaudio/best',
    '--no-playlist',
    '--newline',
    '--no-part',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
    '--ffmpeg-location',
    ffmpegPath(),
    '-o',
    template
  ]

  if (opts.isLive) args.push('--live-from-start')

  args.push(opts.url)

  let finalPath = ''
  const handle = run(
    bin,
    args,
    (line) => {
      const m = line.match(PCT)
      if (m && opts.onProgress) opts.onProgress(Number(m[1]), 'downloaden')
      const dest = line.match(/\[download\] Destination: (.+)$/)
      if (dest) finalPath = dest[1].trim()
      const merge = line.match(/\[Merger\] Merging formats into "(.+)"$/)
      if (merge) finalPath = merge[1].trim()
      const already = line.match(/\[download\] (.+) has already been downloaded/)
      if (already) finalPath = already[1].trim()
      const cut = line.match(/\[ExtractAudio\] Destination: (.+)$/)
      if (cut) finalPath = cut[1].trim()
    },
    opts.signal
  )

  await handle.done

  if (finalPath && fs.existsSync(finalPath)) return finalPath

  // Val terug op zoeken in de map als yt-dlp geen bruikbaar pad printte.
  const files = await fsp.readdir(opts.outDir)
  const match = files.find((f) => f.startsWith(opts.outBase + '.'))
  if (!match) throw new Error('Download klaar maar bestand niet gevonden')
  return path.join(opts.outDir, match)
}

/* ------------------------------ thumbnail -------------------------------- */

export async function downloadThumbnail(url: string, dest: string): Promise<string> {
  if (!url) throw new Error('Geen thumbnail-URL')
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const get = (target: string, depth = 0): void => {
      if (depth > 5) return reject(new Error('Te veel redirects'))
      https
        .get(target, { headers: { 'User-Agent': 'FlacDeck' } }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            return get(new URL(res.headers.location, target).toString(), depth + 1)
          }
          if (res.statusCode !== 200) {
            res.resume()
            return reject(new Error('Thumbnail HTTP ' + res.statusCode))
          }
          const file = fs.createWriteStream(dest)
          res.pipe(file)
          file.on('finish', () => file.close(() => resolve()))
          file.on('error', reject)
        })
        .on('error', reject)
    }
    get(url)
  })
  return dest
}
