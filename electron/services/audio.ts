import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ffmpegPath, ffprobePath } from './binaries'
import { CancelledError } from './ytdlp'
import type { AudioSettings, TrackMeta } from '../../shared/types'

function runFfmpeg(
  args: string[],
  onProgress?: (outSeconds: number) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true })
    let stderr = ''
    let buf = ''

    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const m = line.match(/^out_time_ms=(\d+)/)
        if (m && onProgress) onProgress(Number(m[1]) / 1_000_000)
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 40_000) stderr = stderr.slice(-20_000)
    })

    const onAbort = (): void => {
      child.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new CancelledError())
      if (code === 0) return resolve()
      const tail = stderr.trim().split('\n').slice(-6).join('\n')
      reject(new Error(tail || 'ffmpeg stopte met code ' + code))
    })
  })
}

function runFfprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath(), args, { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || 'ffprobe code ' + code))
    )
  })
}

export interface MediaInfo {
  duration: number
  sampleRate: number
  channels: number
  codec: string
  bitrate: number
  tags: Record<string, string>
}

export async function mediaInfo(file: string): Promise<MediaInfo> {
  const out = await runFfprobe([
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-select_streams',
    'a:0',
    file
  ])
  const json = JSON.parse(out) as {
    format?: { duration?: string; bit_rate?: string; tags?: Record<string, string> }
    streams?: { sample_rate?: string; channels?: number; codec_name?: string; tags?: Record<string, string> }[]
  }
  const stream = json.streams?.[0] ?? {}
  const tags: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...(json.format?.tags ?? {}), ...(stream.tags ?? {}) })) {
    tags[k.toUpperCase()] = String(v)
  }
  return {
    duration: Number(json.format?.duration ?? 0),
    sampleRate: Number(stream.sample_rate ?? 0),
    channels: Number(stream.channels ?? 0),
    codec: String(stream.codec_name ?? ''),
    bitrate: Number(json.format?.bit_rate ?? 0),
    tags
  }
}

/**
 * Maakt van een willekeurige afbeelding een vierkante JPEG die DJ-spelers
 * probleemloos tonen. Te grote artwork maakt bladeren op een CDJ traag.
 */
export async function prepareCover(input: string, output: string, square: boolean): Promise<string> {
  const filter = square
    ? "crop='min(iw,ih)':'min(iw,ih)',scale=800:800:flags=lanczos"
    : "scale='min(1000,iw)':-2:flags=lanczos"
  await fsp.mkdir(path.dirname(output), { recursive: true })
  await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', input, '-vf', filter, '-q:v', '3', output])
  return output
}

function metaArgs(meta: TrackMeta): string[] {
  const args: string[] = []
  const put = (key: string, value: string): void => {
    const v = value?.trim()
    if (v) args.push('-metadata', key + '=' + v)
  }

  put('title', meta.title)
  put('artist', meta.artist)
  put('album', meta.album)
  put('album_artist', meta.albumArtist || meta.artist)
  put('genre', meta.genre)
  put('date', meta.year)
  put('comment', meta.comment)

  // Vorbis-comments die Rekordbox / Engine DJ uitleest.
  if (meta.trackNumber.trim()) {
    put('track', meta.totalTracks.trim() ? meta.trackNumber + '/' + meta.totalTracks : meta.trackNumber)
    put('TRACKNUMBER', meta.trackNumber)
  }
  put('TRACKTOTAL', meta.totalTracks)
  put('TOTALTRACKS', meta.totalTracks)
  put('BPM', meta.bpm)
  put('TEMPO', meta.bpm)
  put('INITIALKEY', meta.initialKey)
  put('KEY', meta.initialKey)
  put('ORGANIZATION', meta.label)
  put('LABEL', meta.label)
  put('YEAR', meta.year)
  // 'encoder' wordt door de muxer overschreven, dus gebruik ENCODEDBY.
  args.push('-metadata', 'ENCODEDBY=FlacDeck')
  return args
}

/**
 * Niet elke ffmpeg-build heeft libsoxr. Vragen om een resampler die er niet is
 * laat het hele filter falen, dus checken we de configuratieregel één keer.
 */
let soxrPromise: Promise<boolean> | null = null
function hasSoxr(): Promise<boolean> {
  if (!soxrPromise) {
    soxrPromise = new Promise<boolean>((resolve) => {
      const child = spawn(ffmpegPath(), ['-hide_banner', '-version'], { windowsHide: true })
      let out = ''
      child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
      child.on('error', () => resolve(false))
      child.on('close', () => resolve(out.includes('--enable-libsoxr')))
    })
  }
  return soxrPromise
}

function filterChain(audio: AudioSettings, durationHint: number, soxr: boolean): string[] {
  const chain: string[] = []
  if (audio.sampleRate !== 'source') {
    chain.push('aresample=' + audio.sampleRate + (soxr ? ':resampler=soxr:precision=28' : ''))
  }
  if (audio.normalize) chain.push('loudnorm=I=' + audio.targetLufs + ':TP=-1.0:LRA=11')
  if (audio.fadeIn > 0) chain.push('afade=t=in:st=0:d=' + audio.fadeIn)
  if (audio.fadeOut > 0 && durationHint > audio.fadeOut) {
    chain.push('afade=t=out:st=' + (durationHint - audio.fadeOut).toFixed(3) + ':d=' + audio.fadeOut)
  }
  return chain
}

export interface EncodeOptions {
  input: string
  output: string
  /** null = vanaf het begin van het bronbestand. */
  start: number | null
  /** null = tot het eind. */
  end: number | null
  meta: TrackMeta
  cover: string | null
  audio: AudioSettings
  onProgress?: (pct: number) => void
  signal?: AbortSignal
}

/** Knipt (optioneel) en encodeert naar FLAC, inclusief tags en cover. */
export async function encodeFlac(opts: EncodeOptions): Promise<{ path: string; size: number; duration: number }> {
  const { input, output, start, end, meta, cover, audio } = opts
  await fsp.mkdir(path.dirname(output), { recursive: true })

  const sourceDuration = (await mediaInfo(input)).duration
  const from = start ?? 0
  const to = end ?? sourceDuration
  const target = Math.max(0, (to || sourceDuration) - from)

  if (start !== null && sourceDuration > 0 && from >= sourceDuration) {
    throw new Error('Starttijd ligt voorbij het einde van de bron')
  }

  const args = ['-hide_banner', '-nostdin', '-y']
  if (start !== null && start > 0) args.push('-ss', String(from))
  args.push('-i', input)
  if (cover) args.push('-i', cover)
  if (end !== null && target > 0) args.push('-t', String(target))

  args.push('-map', '0:a:0')
  if (cover) {
    args.push(
      '-map',
      '1:v:0',
      '-c:v',
      'copy',
      '-disposition:v',
      'attached_pic',
      '-metadata:s:v',
      'title=Album cover',
      '-metadata:s:v',
      'comment=Cover (front)'
    )
  }

  args.push('-c:a', 'flac', '-compression_level', String(audio.compression))
  if (audio.channels === 'stereo') args.push('-ac', '2')
  if (audio.bitDepth === '16') args.push('-sample_fmt', 's16')
  else if (audio.bitDepth === '24') args.push('-sample_fmt', 's32', '-bits_per_raw_sample', '24')

  const chain = filterChain(audio, target, await hasSoxr())
  if (chain.length) args.push('-af', chain.join(','))

  args.push(...metaArgs(meta))
  args.push('-progress', 'pipe:1', '-nostats', output)

  await runFfmpeg(
    args,
    (outSeconds) => {
      if (opts.onProgress && target > 0) {
        opts.onProgress(Math.min(99, Math.round((outSeconds / target) * 100)))
      }
    },
    opts.signal
  )

  const stat = await fsp.stat(output)
  const info = await mediaInfo(output)
  return { path: output, size: stat.size, duration: info.duration }
}
