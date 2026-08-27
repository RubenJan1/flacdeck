import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { mediaInfo } from './audio'
import { applyTemplate, sanitize, uniqueName } from './naming'
import { emptyMeta, type DriveInfo, type ExportLayout, type ExportRequest, type ExportResult, type TrackMeta } from '../../shared/types'

const execFileAsync = promisify(execFile)

/* ----------------------------- schijven zoeken ---------------------------- */

async function windowsDrives(): Promise<DriveInfo[]> {
  const script =
    'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace,DriveType | ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }
  )
  const parsed: unknown = JSON.parse(stdout.trim() || '[]')
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .filter((r): r is Record<string, unknown> => Boolean(r))
    .map((r) => ({
      path: String(r.DeviceID ?? '') + '\\',
      label: String(r.VolumeName ?? '') || String(r.DeviceID ?? ''),
      filesystem: String(r.FileSystem ?? ''),
      totalBytes: Number(r.Size ?? 0),
      freeBytes: Number(r.FreeSpace ?? 0),
      removable: Number(r.DriveType ?? 0) === 2
    }))
    .filter((d) => d.totalBytes > 0)
}

async function macDrives(): Promise<DriveInfo[]> {
  let names: string[] = []
  try {
    names = await fsp.readdir('/Volumes')
  } catch {
    return []
  }

  const out: DriveInfo[] = []
  for (const name of names) {
    const mount = path.join('/Volumes', name)
    try {
      const { stdout } = await execFileAsync('diskutil', ['info', '-plist', mount], { timeout: 15000 })
      const bool = (key: string): boolean =>
        new RegExp('<key>' + key + '</key>\\s*<(true|false)/>').exec(stdout)?.[1] === 'true'
      const num = (key: string): number =>
        Number(new RegExp('<key>' + key + '</key>\\s*<integer>(\\d+)</integer>').exec(stdout)?.[1] ?? 0)
      const str = (key: string): string =>
        new RegExp('<key>' + key + '</key>\\s*<string>([^<]*)</string>').exec(stdout)?.[1] ?? ''

      out.push({
        path: mount,
        label: name,
        filesystem: str('FilesystemName') || str('FilesystemType'),
        totalBytes: num('TotalSize') || num('Size'),
        freeBytes: num('FreeSpace') || num('APFSContainerFree'),
        removable: bool('Removable') || bool('Ejectable') || bool('RemovableMediaOrExternalDevice')
      })
    } catch {
      out.push({ path: mount, label: name, filesystem: '', totalBytes: 0, freeBytes: 0, removable: true })
    }
  }
  return out
}

export async function listDrives(): Promise<DriveInfo[]> {
  try {
    const drives = process.platform === 'win32' ? await windowsDrives() : await macDrives()
    return drives.sort((a, b) => Number(b.removable) - Number(a.removable) || a.path.localeCompare(b.path))
  } catch {
    return []
  }
}

/* ------------------------------- layouts --------------------------------- */

const LAYOUTS: Record<
  ExportLayout,
  { root: string; dirs: string[]; file: string; ascii: boolean; maxLen: number; label: string; hint: string }
> = {
  dj: {
    root: 'Contents',
    dirs: ['{albumartist}', '{album}'],
    file: '{track} {artist} - {title}',
    ascii: false,
    maxLen: 90,
    label: 'DJ-speler (Pioneer / Denon)',
    hint: 'Contents/Artiest/Album/. Tags in Vorbis-formaat; rekordbox of Engine analyseert daarna zelf BPM en toonsoort.'
  },
  car: {
    root: 'Music',
    dirs: ['{artist}', '{album}'],
    file: '{track} - {title}',
    ascii: true,
    maxLen: 60,
    label: 'Auto / hifi USB-speler',
    hint: 'Korte ASCII-namen, geen accenten of rare tekens. Werkt op oudere autoradio-USB-spelers.'
  },
  flat: {
    root: '',
    dirs: [],
    file: '{artist} - {title}',
    ascii: false,
    maxLen: 100,
    label: 'Alles in één map',
    hint: 'Geen mappen, alles los in de hoofdmap van de stick.'
  },
  library: {
    root: 'Muziek',
    dirs: ['{genre}', '{albumartist}', '{album}'],
    file: '{track} - {title}',
    ascii: false,
    maxLen: 100,
    label: 'Bibliotheek (Genre/Artiest/Album)',
    hint: 'Nette boom om zelf te archiveren.'
  }
}

export function layoutOptions(): { id: ExportLayout; label: string; hint: string }[] {
  return (Object.keys(LAYOUTS) as ExportLayout[]).map((id) => ({
    id,
    label: LAYOUTS[id].label,
    hint: LAYOUTS[id].hint
  }))
}

/** Leest de tags terug uit een FLAC zodat de export op echte metadata bouwt. */
async function metaOf(file: string): Promise<{ meta: TrackMeta; duration: number }> {
  const info = await mediaInfo(file)
  const t = info.tags
  const trackRaw = t.TRACK ?? t.TRACKNUMBER ?? ''
  const meta: TrackMeta = {
    ...emptyMeta(),
    artist: t.ARTIST ?? '',
    title: t.TITLE ?? path.basename(file, path.extname(file)),
    album: t.ALBUM ?? '',
    albumArtist: t.ALBUM_ARTIST ?? t.ALBUMARTIST ?? t.ARTIST ?? '',
    genre: t.GENRE ?? '',
    year: (t.DATE ?? t.YEAR ?? '').slice(0, 4),
    trackNumber: trackRaw.split('/')[0] ?? '',
    totalTracks: t.TRACKTOTAL ?? t.TOTALTRACKS ?? trackRaw.split('/')[1] ?? '',
    bpm: t.BPM ?? '',
    initialKey: t.INITIALKEY ?? t.KEY ?? '',
    label: t.LABEL ?? t.ORGANIZATION ?? '',
    comment: t.COMMENT ?? ''
  }
  return { meta, duration: info.duration }
}

/**
 * Zoekt in dir naar "base.flac" of "base (n).flac" met exact deze grootte.
 * Dat is de goedkoopste betrouwbare manier om te zien of dit nummer er al staat.
 */
async function findCopy(dir: string, base: string, size: number): Promise<string | null> {
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return null
  }
  const prefix = base.toLowerCase()
  for (const name of names) {
    const lower = name.toLowerCase()
    if (!lower.endsWith('.flac')) continue
    const stem = lower.slice(0, -5)
    if (stem !== prefix && !/^ \(\d+\)$/.test(stem.slice(prefix.length))) continue
    if (!stem.startsWith(prefix)) continue
    const full = path.join(dir, name)
    try {
      if ((await fsp.stat(full)).size === size) return full
    } catch {
      /* net weggehaald */
    }
  }
  return null
}

async function copyFile(src: string, dest: string): Promise<number> {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.copyFile(src, dest)
  return (await fsp.stat(dest)).size
}

function fsWarnings(target: string, filesystem: string, layout: ExportLayout): string[] {
  const warnings: string[] = []
  const fsName = filesystem.toUpperCase()
  if (layout === 'dj') {
    if (fsName.includes('NTFS')) {
      warnings.push(
        'De stick is NTFS. Pioneer- en Denon-spelers lezen alleen FAT32 of exFAT — formatteer de stick opnieuw als exFAT.'
      )
    } else if (fsName.includes('APFS') || fsName.includes('HFS')) {
      warnings.push(
        'De stick is ' + filesystem + ' (Mac-formaat). DJ-spelers lezen dat niet — formatteer als exFAT of FAT32 (MS-DOS).'
      )
    } else if (!fsName) {
      warnings.push('Bestandssysteem onbekend. Zorg dat de stick FAT32 of exFAT is, anders leest de speler hem niet.')
    }
  }
  if (!fs.existsSync(target)) warnings.push('Doelmap bestaat niet meer.')
  return warnings
}

export async function exportTracks(
  req: ExportRequest,
  onProgress?: (done: number, total: number, current: string) => void
): Promise<ExportResult> {
  const layout = LAYOUTS[req.layout]
  const ascii = req.asciiNames || layout.ascii
  const result: ExportResult = {
    copied: 0,
    skipped: 0,
    failed: [],
    bytes: 0,
    playlistPath: null,
    warnings: []
  }

  const drives = await listDrives()
  const drive = drives.find((d) => req.target.toLowerCase().startsWith(d.path.toLowerCase()))
  result.warnings.push(...fsWarnings(req.target, drive?.filesystem ?? '', req.layout))

  const rootDir = layout.root ? path.join(req.target, layout.root) : req.target
  await fsp.mkdir(rootDir, { recursive: true })

  const takenPerDir = new Map<string, Set<string>>()
  const playlistEntries: { relative: string; meta: TrackMeta; duration: number }[] = []

  for (let i = 0; i < req.paths.length; i += 1) {
    const src = req.paths[i]
    onProgress?.(i, req.paths.length, path.basename(src))
    try {
      const { meta, duration } = await metaOf(src)

      const dirParts = layout.dirs
        .map((tpl) => applyTemplate(tpl, meta, { ascii, maxLength: layout.maxLen }))
        .filter((p) => p && p !== 'naamloos')
      const dir = path.join(rootDir, ...dirParts)

      const key = dir.toLowerCase()
      if (!takenPerDir.has(key)) {
        takenPerDir.set(key, new Set(fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => f.toLowerCase()) : []))
      }
      const taken = takenPerDir.get(key) as Set<string>

      const base = applyTemplate(layout.file, meta, { ascii, maxLength: layout.maxLen })

      let dest: string
      if (req.overwrite) {
        dest = path.join(dir, base + '.flac')
        taken.add((base + '.flac').toLowerCase())
      } else {
        // Ook eerder hernoemde kopieën meenemen, anders groeit de stick bij elke
        // export aan met "(2)", "(3)", "(4)" van hetzelfde nummer.
        const already = await findCopy(dir, base, (await fsp.stat(src)).size)
        if (already) {
          result.skipped += 1
          playlistEntries.push({ relative: path.relative(req.target, already), meta, duration })
          continue
        }
        dest = path.join(dir, uniqueName(base, '.flac', taken))
      }

      result.bytes += await copyFile(src, dest)
      result.copied += 1
      playlistEntries.push({ relative: path.relative(req.target, dest), meta, duration })
    } catch (err) {
      result.failed.push({ path: src, error: (err as Error).message })
    }
  }
  onProgress?.(req.paths.length, req.paths.length, '')

  if (req.createM3u && playlistEntries.length) {
    const name = sanitize(req.playlistName || 'FlacDeck', { ascii, maxLength: 60 })
    const playlistPath = path.join(req.target, name + '.m3u8')
    const lines = ['#EXTM3U']
    for (const e of playlistEntries) {
      const secs = Math.round(e.duration) || -1
      lines.push('#EXTINF:' + secs + ',' + (e.meta.artist ? e.meta.artist + ' - ' : '') + e.meta.title)
      lines.push(e.relative.split(path.sep).join('/'))
    }
    await fsp.writeFile(playlistPath, lines.join('\r\n') + '\r\n', 'utf8')
    result.playlistPath = playlistPath
  }

  return result
}

/** Ruwe schatting of alles past. */
export async function exportSize(paths: string[]): Promise<number> {
  let total = 0
  for (const p of paths) {
    try {
      total += (await fsp.stat(p)).size
    } catch {
      /* bestand weg, negeer */
    }
  }
  return total
}
