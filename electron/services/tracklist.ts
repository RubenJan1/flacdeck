import { randomUUID } from 'node:crypto'
import { emptyMeta, type Chapter, type Segment, type TrackMeta } from '../../shared/types'

/** "1:02:03" / "12:34" / "90" -> seconden. Geeft null bij onzin. */
export function parseTime(raw: string): number | null {
  const s = raw.trim().replace(',', '.')
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const parts = s.split(':')
  if (parts.length < 2 || parts.length > 3) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => Number.isNaN(n) || n < 0)) return null
  if (parts.length === 2) return nums[0] * 60 + nums[1]
  return nums[0] * 3600 + nums[1] * 60 + nums[2]
}

export function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return ''
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?`

/** Rommel die in YouTube-titels zit maar niet in de tags hoort. */
const TITLE_NOISE = [
  /\[(official\s*)?(music\s*)?(video|audio|lyric[s]?|visualizer|hd|hq|4k|free\s*download|premiere|out\s*now)\]/gi,
  /\((official\s*)?(music\s*)?(video|audio|lyric[s]?\s*video|visualizer|hd|hq|4k|free\s*download|premiere|out\s*now)\)/gi,
  /\bofficial\s+(music\s+)?video\b/gi,
  /\bfull\s+album\b/gi,
  /\|\s*$/
]

function clean(s: string): string {
  let out = s
  for (const re of TITLE_NOISE) out = out.replace(re, ' ')
  return out.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—_.·•|]+|[\s\-–—_.·•|]+$/g, '').trim()
}

/** Splitst "Artiest - Titel" op de eerste losstaande streep. */
export function splitArtistTitle(raw: string): { artist: string; title: string } {
  const line = clean(raw)
  const m = line.match(/^(.{1,120}?)\s+[-–—]\s+(.+)$/)
  if (m) return { artist: clean(m[1]), title: clean(m[2]) }
  const colon = line.match(/^([^:]{1,60}):\s+(.+)$/)
  if (colon && !/^\d+$/.test(colon[1])) return { artist: clean(colon[1]), title: clean(colon[2]) }
  return { artist: '', title: line }
}

function metaFrom(label: string, base: Partial<TrackMeta>): TrackMeta {
  const { artist, title } = splitArtistTitle(label)
  return { ...emptyMeta(), ...base, artist: artist || String(base.artist ?? ''), title: title || label }
}

/** Segmenten uit yt-dlp hoofdstukken. Meest betrouwbare bron. */
export function segmentsFromChapters(chapters: Chapter[], base: Partial<TrackMeta> = {}): Segment[] {
  return chapters
    .filter((c) => Number.isFinite(c.start))
    .map((c, i, arr) => ({
      id: randomUUID(),
      enabled: true,
      start: Math.max(0, c.start),
      end: Number.isFinite(c.end) && c.end > c.start ? c.end : null,
      meta: {
        ...metaFrom(c.title ?? '', base),
        trackNumber: String(i + 1),
        totalTracks: String(arr.length)
      }
    }))
}

interface RawEntry {
  start: number
  end: number | null
  label: string
}

/**
 * Trekt een tracklist uit een videobeschrijving of een geplakt blok tekst.
 * Slikt "00:00 Artist - Title", "1. [00:00] ...", "Artist - Title 00:00"
 * en ranges als "00:00 - 04:12 Artist - Title".
 */
export function parseTracklistText(text: string): RawEntry[] {
  if (!text) return []
  const entries: RawEntry[] = []

  const rangeRe = new RegExp(String.raw`^(${TIME})\s*[-–—]{1,2}\s*(${TIME})\b(.*)$`)
  const leadRe = new RegExp(String.raw`^(${TIME})\b(.*)$`)
  const trailRe = new RegExp(String.raw`^(.*?)\s*[\[\(]?(${TIME})[\]\)]?\s*$`)

  for (const rawLine of text.split(/\r?\n/)) {
    // Strip lijstnummering en haakjes rond de tijd.
    let line = rawLine.trim().replace(/^[\s>*•·\-–—]+/, '')
    line = line.replace(/^\d{1,3}[.)]\s+/, '')
    line = line.replace(/[\[\(](\d{1,2}:\d{2}(?::\d{2})?)[\]\)]/, '$1')
    if (!line) continue

    let start: number | null = null
    let end: number | null = null
    let label = ''

    const range = line.match(rangeRe)
    const lead = line.match(leadRe)
    const trail = line.match(trailRe)

    if (range) {
      start = parseTime(range[1])
      end = parseTime(range[2])
      label = range[3]
    } else if (lead) {
      start = parseTime(lead[1])
      label = lead[2]
    } else if (trail && trail[1].trim()) {
      start = parseTime(trail[2])
      label = trail[1]
    } else {
      continue
    }

    if (start === null) continue
    label = label.replace(/^[\s\-–—:.|]+/, '').trim()
    if (!label) continue
    entries.push({ start, end, label })
  }

  // Oplopend sorteren en duplicaten op hetzelfde tijdstip weggooien.
  entries.sort((a, b) => a.start - b.start)
  return entries.filter((e, i) => i === 0 || e.start !== entries[i - 1].start)
}

/** Zet losse tekst om in segmenten; open einde wordt het begin van de volgende track. */
export function segmentsFromText(
  text: string,
  base: Partial<TrackMeta> = {},
  sourceDuration = 0
): Segment[] {
  const entries = parseTracklistText(text)
  return entries.map((e, i) => {
    const next = entries[i + 1]
    const end = e.end ?? (next ? next.start : sourceDuration > 0 ? sourceDuration : null)
    return {
      id: randomUUID(),
      enabled: true,
      start: e.start,
      end,
      meta: {
        ...metaFrom(e.label, base),
        trackNumber: String(i + 1),
        totalTracks: String(entries.length)
      }
    }
  })
}

/** Eén segment voor de hele bron. */
export function wholeSegment(title: string, base: Partial<TrackMeta> = {}): Segment {
  return {
    id: randomUUID(),
    enabled: true,
    start: null,
    end: null,
    meta: metaFrom(title, base)
  }
}
