import type { TrackMeta } from '../../shared/types'

/** Namen die Windows sowieso weigert, ongeacht extensie. */
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
])

const TRANSLIT: Record<string, string> = {
  á: 'a', à: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a', æ: 'ae',
  é: 'e', è: 'e', ê: 'e', ë: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', ö: 'o', õ: 'o', ø: 'o', œ: 'oe',
  ú: 'u', ù: 'u', û: 'u', ü: 'u',
  ñ: 'n', ç: 'c', ß: 'ss', ý: 'y', ÿ: 'y', ð: 'd', þ: 'th',
  '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...'
}

function toAscii(input: string): string {
  let out = ''
  for (const ch of input) {
    const lower = ch.toLowerCase()
    const mapped = TRANSLIT[lower]
    if (mapped) {
      out += ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1)
    } else if (ch.charCodeAt(0) < 128) {
      out += ch
    } else {
      const norm = ch.normalize('NFD').replace(/[̀-ͯ]/g, '')
      out += /^[\x20-\x7e]+$/.test(norm) ? norm : '_'
    }
  }
  return out
}

export interface SanitizeOptions {
  ascii?: boolean
  maxLength?: number
}

/**
 * Maakt van een string een bestandsnaam die op FAT32/exFAT en op DJ-spelers
 * werkt: geen verboden tekens, geen punt of spatie aan het eind, niet te lang.
 */
export function sanitize(raw: string, opts: SanitizeOptions = {}): string {
  const maxLength = opts.maxLength ?? 100
  let name = (raw ?? '').trim()
  if (opts.ascii) name = toAscii(name)

  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f\x7f]/g, '')
  name = name.replace(/[<>:"/\\|?*]/g, '-')
  name = name.replace(/\s{2,}/g, ' ')
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')

  if (name.length > maxLength) name = name.slice(0, maxLength).trim().replace(/[.\s]+$/, '')
  if (!name) name = 'naamloos'
  if (RESERVED.has(name.toUpperCase())) name = '_' + name
  return name
}

function pad(value: string, width = 2): string {
  const n = Number(value)
  if (!value || Number.isNaN(n)) return ''
  return String(n).padStart(width, '0')
}

/**
 * Vult een naamsjabloon. Beschikbaar: {artist} {title} {album} {albumartist}
 * {track} {tracknum} {year} {genre} {bpm} {key} {label}
 */
export function applyTemplate(template: string, meta: TrackMeta, opts: SanitizeOptions = {}): string {
  const values: Record<string, string> = {
    artist: meta.artist || 'Onbekende artiest',
    albumartist: meta.albumArtist || meta.artist || 'Onbekende artiest',
    title: meta.title || 'Onbekende titel',
    album: meta.album || '',
    track: pad(meta.trackNumber),
    tracknum: meta.trackNumber || '',
    year: meta.year || '',
    genre: meta.genre || '',
    bpm: meta.bpm || '',
    key: meta.initialKey || '',
    label: meta.label || ''
  }

  const filled = template.replace(/\{(\w+)\}/g, (_, key: string) => values[key.toLowerCase()] ?? '')

  // Lege tokens laten scheidingstekens achter; die ruimen we op.
  return sanitize(
    filled
      .replace(/\s*-\s*-\s*/g, ' - ')
      .replace(/^\s*[-–—]\s*/, '')
      .replace(/\s*[-–—]\s*$/, ''),
    opts
  )
}

/** Voegt " (2)", " (3)" toe zolang de naam al bestaat in de set. */
export function uniqueName(base: string, ext: string, taken: Set<string>): string {
  let candidate = base + ext
  let n = 2
  while (taken.has(candidate.toLowerCase())) {
    candidate = base + ' (' + n + ')' + ext
    n += 1
  }
  taken.add(candidate.toLowerCase())
  return candidate
}
