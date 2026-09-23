import type { Dirent } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { mediaInfo } from './audio'
import { applyTemplate, sanitize, uniqueName } from './naming'
import {
  emptyMeta,
  type DriveCheck,
  type DriveInfo,
  type EjectResult,
  type ExportLayout,
  type ExportRequest,
  type ExportResult,
  type TrackMeta
} from '../../shared/types'

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

/**
 * Kopieert en dwingt de schrijfcache naar de stick.
 *
 * Zonder die fsync blijft een kopie in het geheugen van het besturingssysteem
 * hangen. macOS cachet schrijfacties naar exFAT ruim, dus meldde FlacDeck
 * "klaar" terwijl er nog niets op de stick stond. Wie hem er dan uittrok hield
 * een halve FAT-tabel over: stick onleesbaar, of nog maar een paar nummers.
 */
async function copyFile(src: string, dest: string): Promise<number> {
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.copyFile(src, dest)
  const handle = await fsp.open(dest, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
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

/* --------------------------- controle vooraf ----------------------------- */

const FORMAT_HELP =
  process.platform === 'darwin'
    ? 'Open Schijfhulpprogramma (Programma’s › Hulpprogramma’s), kies de stick in de linkerkolom, klik op Wissen en kies bij Structuur de optie ExFAT. Let op: alles wat er nu op staat gaat weg.'
    : 'Klik in Verkenner met de rechtermuisknop op de stick, kies Formatteren en zet Bestandssysteem op exFAT. Let op: alles wat er nu op staat gaat weg.'

/**
 * Kijkt vóór het kopiëren of deze stick bruikbaar is. Eerst alles kopiëren en
 * daarna pas melden dat een speler het niet leest is precies de val waar een
 * onervaren gebruiker in trapt.
 */
export async function checkDrive(target: string, layout: ExportLayout): Promise<DriveCheck> {
  if (!target) {
    return {
      level: 'block',
      title: 'Nog geen stick gekozen',
      message: 'Er is niets geselecteerd om naar te kopiëren.',
      fix: 'Steek een USB-stick in de computer en kies hem in de lijst.'
    }
  }

  if (!fs.existsSync(target)) {
    return {
      level: 'block',
      title: 'De stick is er niet meer',
      message: 'De computer ziet ' + target + ' niet meer. Waarschijnlijk is de stick eruit gehaald.',
      fix: 'Steek de stick er opnieuw in en klik daarna op “Opnieuw zoeken”.'
    }
  }

  // Echt proberen te schrijven: alleen zo komen schrijfbeveiliging en een
  // alleen-lezen aangekoppelde NTFS-stick op de Mac boven water.
  const probe = path.join(target, '.flacdeck-test')
  try {
    await fsp.writeFile(probe, 'x')
    await fsp.rm(probe, { force: true })
  } catch {
    return {
      level: 'block',
      title: 'Er kan niets op deze stick geschreven worden',
      message:
        process.platform === 'darwin'
          ? 'De Mac mag niet op deze stick schrijven. Dat komt bijna altijd doordat de stick in Windows-formaat NTFS staat; macOS kan die alleen lezen.'
          : 'Windows mag niet op deze stick schrijven. Mogelijk staat het schuifje voor schrijfbeveiliging op de stick aan.',
      fix: FORMAT_HELP
    }
  }

  const drives = await listDrives()
  const drive = drives.find((d) => target.toLowerCase().startsWith(d.path.toLowerCase()))
  const fsName = (drive?.filesystem ?? '').toUpperCase()
  const playerLayout = layout === 'dj' || layout === 'car'

  if (playerLayout && (fsName.includes('APFS') || fsName.includes('HFS'))) {
    return {
      level: 'block',
      title: 'Deze stick staat in Mac-formaat',
      message:
        'De stick is opgemaakt als ' +
        (drive?.filesystem ?? 'Mac OS Extended') +
        '. Een DJ-speler of autoradio leest dat niet: die ziet straks een lege stick.',
      fix: FORMAT_HELP
    }
  }

  if (playerLayout && fsName.includes('NTFS')) {
    return {
      level: 'block',
      title: 'Deze stick staat in NTFS',
      message: 'Pioneer, Denon en autoradio’s lezen alleen FAT32 of exFAT. NTFS blijft stil.',
      fix: FORMAT_HELP
    }
  }

  if (!fsName) {
    return {
      level: 'warn',
      title: 'Onbekend formaat',
      message: 'FlacDeck kan niet vaststellen hoe deze stick is opgemaakt.',
      fix: 'Werkt de stick straks niet in de speler, maak hem dan opnieuw op als exFAT.'
    }
  }

  return {
    level: 'ok',
    title: 'Deze stick is goed',
    message:
      (drive?.label ? drive.label + ' · ' : '') + (drive?.filesystem || 'onbekend') + ' — klaar voor gebruik.',
    fix: ''
  }
}

/* ------------------------- verborgen rommel weg --------------------------- */

/**
 * Alleen de mappen die macOS zelf op een FAT-stick zet. Windows-eigen dingen
 * als System Volume Information, $RECYCLE.BIN en desktop.ini blijven met rust:
 * die horen bij de schijf en zijn niet van ons om weg te gooien.
 */
const JUNK_DIRS = new Set([
  '.spotlight-v100',
  '.fseventsd',
  '.trashes',
  '.temporaryitems',
  '.documentrevisions-v100'
])

function isJunkFile(name: string): boolean {
  return name.toLowerCase() === '.ds_store' || name.startsWith('._')
}

/**
 * macOS strooit "._Naam.flac" en .DS_Store over elke FAT-stick. Autoradio's en
 * oudere CDJ's tellen die AppleDouble-bestanden mee als nummer of slaan erop
 * stuk: je hoort dan twee tellen ruis tussen elk nummer, of de speler slaat de
 * hele map over. Ze horen er dus af voordat de stick de deur uit gaat.
 *
 * Draait uitsluitend op een verwisselbare schijf. Op een vaste schijf zou dit
 * bestanden opruimen waar FlacDeck niets mee te maken heeft.
 */
export async function cleanupDrive(target: string): Promise<number> {
  const drives = await listDrives()
  const drive = drives.find((d) => target.toLowerCase().startsWith(d.path.toLowerCase()))
  if (!drive?.removable) return 0
  return sweep(target, 0)
}

async function sweep(dir: string, depth: number): Promise<number> {
  if (depth > 6) return 0
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }

  let removed = 0
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        if (JUNK_DIRS.has(entry.name.toLowerCase())) {
          await fsp.rm(full, { recursive: true, force: true })
          removed += 1
        } else {
          removed += await sweep(full, depth + 1)
        }
      } else if (isJunkFile(entry.name)) {
        await fsp.rm(full, { force: true })
        removed += 1
      }
    } catch {
      /* mag mislukken: systeembestanden zijn soms in gebruik */
    }
  }
  return removed
}

/* ---------------------------- veilig uitwerpen ---------------------------- */

/** De schijf waar target op ligt, of null als dat er geen blijkt te zijn. */
async function driveOf(target: string): Promise<DriveInfo | null> {
  const drives = await listDrives()
  return drives.find((d) => target.toLowerCase().startsWith(d.path.toLowerCase())) ?? null
}

/**
 * Werpt de stick uit. Dat is tegelijk de enige echte garantie dat alles op de
 * stick staat: het besturingssysteem schrijft bij het ontkoppelen zijn laatste
 * buffers weg. Daarom is dit in de eenvoudige modus geen keuze maar een stap.
 */
export async function ejectDrive(target: string): Promise<EjectResult> {
  const drive = await driveOf(target)

  // Nooit zomaar de schijf uitwerpen waar target toevallig op ligt: wie in de
  // geavanceerde modus een gewone map koos, zou anders zijn systeemschijf
  // aanbieden om losgekoppeld te worden.
  if (!drive) {
    return {
      ok: false,
      message: 'Deze map hoort niet bij een schijf die FlacDeck kan loskoppelen. Werp hem met de hand uit.'
    }
  }
  if (!drive.removable) {
    return {
      ok: false,
      message:
        (drive.label || drive.path) +
        ' is een vaste schijf, geen losse stick. Die hoeft niet losgekoppeld te worden.'
    }
  }

  const root = drive.path

  try {
    if (process.platform === 'darwin') {
      await execFileAsync('diskutil', ['eject', root], { timeout: 60000 })
    } else {
      const letter = root.replace(/[\\/:]/g, '').slice(0, 1).toUpperCase()
      if (!/^[A-Z]$/.test(letter)) throw new Error('Geen geldige schijfletter gevonden voor ' + root)
      // Write-VolumeCache leegt eerst de schrijfcache, daarna pas uitwerpen.
      const script =
        "try { Write-VolumeCache -DriveLetter '" +
        letter +
        "' -ErrorAction Stop } catch {}; " +
        "$item = (New-Object -comObject Shell.Application).Namespace(17).ParseName('" +
        letter +
        ":'); " +
        "if ($item) { $item.InvokeVerb('Eject') }"
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 60000
      })
    }
  } catch (err) {
    return {
      ok: false,
      message:
        'Uitwerpen lukte niet: ' +
        (err as Error).message.trim().split('\n')[0] +
        '. Trek de stick er nog NIET uit — werp hem met de hand uit ' +
        (process.platform === 'darwin'
          ? '(sleep de stick naar de prullenbak, of klik op het uitwerp-pijltje in de Finder).'
          : '(klik rechtsonder op het USB-icoon en kies Uitwerpen).')
    }
  }

  // Wachten tot de koppeling echt weg is; pas dan mag de stick eruit.
  for (let i = 0; i < 24; i += 1) {
    if (!fs.existsSync(root)) {
      return { ok: true, message: 'De stick is losgekoppeld. Je mag hem er nu uithalen.' }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  return {
    ok: false,
    message:
      'De computer houdt de stick nog vast. Sluit programma’s die bestanden van de stick open hebben en werp hem daarna met de hand uit. Trek hem er niet zomaar uit.'
  }
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
    warnings: [],
    verified: 0,
    missing: [],
    junkRemoved: 0
  }

  const drives = await listDrives()
  const drive = drives.find((d) => req.target.toLowerCase().startsWith(d.path.toLowerCase()))
  result.warnings.push(...fsWarnings(req.target, drive?.filesystem ?? '', req.layout))

  const rootDir = layout.root ? path.join(req.target, layout.root) : req.target
  await fsp.mkdir(rootDir, { recursive: true })

  const takenPerDir = new Map<string, Set<string>>()
  const playlistEntries: {
    relative: string
    absolute: string
    size: number
    meta: TrackMeta
    duration: number
  }[] = []

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
        const srcSize = (await fsp.stat(src)).size
        const already = await findCopy(dir, base, srcSize)
        if (already) {
          result.skipped += 1
          playlistEntries.push({
            relative: path.relative(req.target, already),
            absolute: already,
            size: srcSize,
            meta,
            duration
          })
          continue
        }
        dest = path.join(dir, uniqueName(base, '.flac', taken))
      }

      const written = await copyFile(src, dest)
      result.bytes += written
      result.copied += 1
      playlistEntries.push({
        relative: path.relative(req.target, dest),
        absolute: dest,
        size: written,
        meta,
        duration
      })
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
    const handle = await fsp.open(playlistPath, 'w')
    try {
      await handle.writeFile(lines.join('\r\n') + '\r\n', 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    result.playlistPath = playlistPath
  }

  result.junkRemoved = await cleanupDrive(req.target)

  // Terugtellen wat er daadwerkelijk op de stick staat. `copied` telt alleen
  // geslaagde schrijfopdrachten; pas een hertelling van de stick zelf bewijst
  // dat de gebruiker straks ook echt al zijn nummers hoort.
  for (const entry of playlistEntries) {
    try {
      const stat = await fsp.stat(entry.absolute)
      if (stat.size === entry.size) result.verified += 1
      else result.missing.push(path.basename(entry.absolute))
    } catch {
      result.missing.push(path.basename(entry.absolute))
    }
  }

  if (result.missing.length) {
    result.warnings.push(
      result.missing.length +
        ' bestand(en) staan niet goed op de stick. Kopieer opnieuw en haal de stick er tussendoor niet uit.'
    )
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
