import type { Dirent } from 'node:fs'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { convertToFlac, mediaInfo } from './audio'
import { applyTemplate, sanitize, uniqueName } from './naming'
import {
  emptyMeta,
  type DriveCheck,
  type DriveInfo,
  type EjectResult,
  type ExportLayout,
  type ExportRequest,
  type ExportResult,
  type FolderScan,
  type TrackMeta,
  type UnreadableStick
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

/* -------------------- sticks die er wel zijn, maar dicht ------------------- */

/**
 * Opmaakadvies. FAT32 en niet exFAT: oudere Pioneer-spelers en veel autoradio's
 * lezen geen exFAT, en een FLAC-nummer komt nooit in de buurt van de 4 GB die
 * FAT32 per bestand toestaat. Master Boot Record om dezelfde reden.
 */
const MAC_STEPS =
  'Open Schijfhulpprogramma (Programma’s › Hulpprogramma’s). Kies in het menu Weergave › Toon alle apparaten, klik links op de bovenste regel van de stick en dan op Wissen. Kies bij Structuur “MS-DOS (FAT)” en bij Schema “Master Boot Record”, en klik op Wis.'
const WINDOWS_EXPLORER_STEPS =
  'Klik in Verkenner met de rechtermuisknop op de stick en kies Formatteren. Zet Bestandssysteem op FAT32 (staat dat er niet bij, kies dan exFAT) en klik op Starten.'
const WINDOWS_DISKMGMT_STEPS =
  'Klik met de rechtermuisknop op de Startknop en kies Schijfbeheer. Klik met de rechtermuisknop op het blok van de stick, kies Volume verwijderen, en daarna Nieuw eenvoudig volume met bestandssysteem FAT32.'
const ERASE_WARNING = 'Let op: alles wat er nu op staat gaat weg.'

// Partitietypes die alleen een Mac leest: APFS en Mac OS Extended (HFS+).
const MAC_GPT_TYPES = ['7c3457ef-0000-11aa-aa11-00306543ecac', '48465300-0000-11aa-aa11-00306543ecac']
const MAC_MBR_TYPE = 175

// Indelingen die een Mac gewoon opent. Staat zo'n stick er zonder koppelpunt,
// dan is hij uitgeworpen of beschadigd.
const MAC_MOUNTABLE = [
  'microsoft basic data',
  'dos_fat_12',
  'dos_fat_16',
  'dos_fat_32',
  'windows_fat_16',
  'windows_fat_32',
  'windows_ntfs',
  'exfat',
  'apple_hfs'
]

type StickText = Pick<UnreadableStick, 'title' | 'message' | 'fix'>

const WINDOWS_TEXT: Record<'mac' | 'leeg' | 'onbekend', StickText> = {
  mac: {
    title: 'Deze stick staat in Mac-formaat',
    message:
      'De stick zit erin, maar is op een Mac opgemaakt. Windows kan hem daardoor niet openen, en een DJ-speler of autoradio ook niet.',
    fix:
      'Het makkelijkst gaat het op de Mac. ' +
      MAC_STEPS +
      ' Geen Mac bij de hand? ' +
      WINDOWS_DISKMGMT_STEPS +
      ' ' +
      ERASE_WARNING
  },
  leeg: {
    title: 'Deze stick is nog niet opgemaakt',
    message: 'De stick zit erin, maar er staat nog geen indeling op. Windows kan er daardoor niets mee.',
    fix:
      'Klik met de rechtermuisknop op de Startknop en kies Schijfbeheer. Klik met de rechtermuisknop op het blok “Niet-toegewezen” van de stick en kies Nieuw eenvoudig volume, met bestandssysteem FAT32.'
  },
  onbekend: {
    title: 'Windows kan deze stick niet openen',
    message:
      'De stick zit erin, maar Windows herkent de indeling niet. Hij komt misschien van een ander apparaat, of is beschadigd.',
    fix:
      'Staan er geen bestanden op die je nog nodig hebt, maak hem dan opnieuw op. ' +
      WINDOWS_DISKMGMT_STEPS +
      ' ' +
      ERASE_WARNING
  }
}

const MAC_TEXT: Record<'leeg' | 'uitgeworpen' | 'onbekend', StickText> = {
  leeg: {
    title: 'Deze stick is nog niet opgemaakt',
    message: 'De stick zit erin, maar er staat nog geen indeling op. De Mac kan er daardoor niets mee.',
    fix: MAC_STEPS
  },
  uitgeworpen: {
    title: 'De stick zit erin, maar is losgekoppeld',
    message: 'De Mac heeft de stick uitgeworpen, of kon hem niet openen.',
    fix:
      'Trek de stick eruit en steek hem er opnieuw in. Verschijnt hij dan nog steeds niet, dan is hij beschadigd en moet hij opnieuw opgemaakt worden. ' +
      MAC_STEPS +
      ' ' +
      ERASE_WARNING
  },
  onbekend: {
    title: 'De Mac kan deze stick niet openen',
    message:
      'De stick zit erin, maar de Mac herkent de indeling niet. Hij komt misschien van een ander apparaat, of is beschadigd.',
    fix:
      'Staan er geen bestanden op die je nog nodig hebt, maak hem dan opnieuw op. ' + MAC_STEPS + ' ' + ERASE_WARNING
  }
}

function records(value: unknown): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
}

/**
 * Uit de USB-schijven die Windows ziet, de sticks zonder bruikbare schijfletter.
 * Verwacht per schijf { Name, Size, Parts: [{ Letter, Gpt, Mbr, Fs }] }.
 */
export function parseWindowsUnreadable(rows: unknown): UnreadableStick[] {
  const out: UnreadableStick[] = []
  for (const disk of records(rows)) {
    const parts = records(disk.Parts).map((p) => ({
      // Een partitie zonder letter geeft PowerShell door als het teken \0.
      letter: String(p.Letter ?? '').replace(/[^A-Za-z]/g, ''),
      gpt: String(p.Gpt ?? '').replace(/[{}]/g, '').toLowerCase(),
      mbr: Number(p.Mbr ?? 0),
      fs: String(p.Fs ?? '')
    }))
    if (parts.some((p) => p.letter && p.fs)) continue

    const kind = !parts.length
      ? 'leeg'
      : parts.some((p) => MAC_GPT_TYPES.includes(p.gpt) || p.mbr === MAC_MBR_TYPE)
        ? 'mac'
        : 'onbekend'
    out.push({
      name: String(disk.Name ?? '').trim() || 'USB-stick',
      totalBytes: Number(disk.Size ?? 0),
      kind,
      ...WINDOWS_TEXT[kind]
    })
  }
  return out
}

/**
 * Uit `diskutil list -plist external physical` (als JSON) de sticks die nergens
 * aangekoppeld zijn. `name` is hier nog het apparaat, zoals disk4.
 */
export function parseMacUnreadable(list: unknown): UnreadableStick[] {
  const root = records(list)[0]
  const out: UnreadableStick[] = []
  for (const disk of records(root?.AllDisksAndPartitions)) {
    const parts = records(disk.Partitions).filter((p) => String(p.Content ?? '') !== 'EFI')
    const contents = [disk, ...parts].map((d) => String(d.Content ?? '').toLowerCase())
    if (Number(disk.Size ?? 0) <= 0) continue
    if ([disk, ...parts].some((d) => d.MountPoint)) continue
    // APFS koppelt de Mac aan via een eigen container-schijf; die staat in
    // /Volumes en wordt daar door checkDrive afgehandeld.
    if (contents.includes('apple_apfs')) continue

    const kind = contents.some((c) => MAC_MOUNTABLE.includes(c))
      ? 'uitgeworpen'
      : !parts.length
        ? 'leeg'
        : 'onbekend'
    out.push({
      name: String(disk.DeviceIdentifier ?? ''),
      totalBytes: Number(disk.Size ?? 0),
      kind,
      ...MAC_TEXT[kind]
    })
  }
  return out
}

async function windowsUnreadable(): Promise<UnreadableStick[]> {
  const script =
    '$out = @(); ' +
    "foreach ($d in @(Get-Disk | Where-Object { $_.BusType -eq 'USB' -and $_.Size -gt 0 -and $_.OperationalStatus -eq 'Online' })) { " +
    '$parts = @(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue | ForEach-Object { ' +
    '$v = Get-Volume -Partition $_ -ErrorAction SilentlyContinue; ' +
    '[pscustomobject]@{ Letter = [string]$_.DriveLetter; Gpt = [string]$_.GptType; Mbr = [string]$_.MbrType; Fs = [string]$v.FileSystem } }); ' +
    '$out += [pscustomobject]@{ Name = $d.FriendlyName; Size = $d.Size; Parts = $parts } }; ' +
    'ConvertTo-Json -InputObject $out -Depth 4 -Compress'
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }
  )
  return parseWindowsUnreadable(JSON.parse(stdout.trim() || '[]'))
}

async function macUnreadable(): Promise<UnreadableStick[]> {
  const { stdout } = await execFileAsync(
    '/bin/sh',
    ['-c', 'diskutil list -plist external physical | plutil -convert json -o - -'],
    { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }
  )
  const found = parseMacUnreadable(JSON.parse(stdout.trim() || '{}'))
  for (const stick of found) {
    try {
      const info = await execFileAsync('diskutil', ['info', '-plist', stick.name], { timeout: 15000 })
      const media = /<key>MediaName<\/key>\s*<string>([^<]*)<\/string>/.exec(info.stdout)?.[1]?.trim()
      stick.name = media || 'USB-stick'
    } catch {
      stick.name = 'USB-stick'
    }
  }
  return found
}

/**
 * Sticks die wel in de computer zitten, maar niet in listDrives verschijnen
 * omdat het systeem ze niet kan openen. Zonder deze melding ziet de gebruiker
 * alleen dat er "niets" is, en blijft hij de stick er in en uit steken.
 */
export async function listUnreadable(): Promise<UnreadableStick[]> {
  try {
    return process.platform === 'win32' ? await windowsUnreadable() : await macUnreadable()
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

/* --------------------------- bestaande muziek ----------------------------- */

/**
 * Wat een DJ-speler (Denon Engine, Pioneer) en de meeste USB-spelers zelf
 * afspelen. Zulke bestanden gaan ongewijzigd mee: een mp3 omzetten naar FLAC
 * maakt hem drie keer zo groot en geen haar beter.
 */
const PLAYER_FORMATS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.aif', '.aiff'])

/**
 * Muziek die een speler niet leest; die wordt onderweg naar FLAC omgezet. De
 * factor is hoeveel groter hij daarbij grofweg wordt, alleen om te schatten of
 * alles op de stick past.
 */
const CONVERT_FORMATS: Record<string, number> = {
  '.ogg': 6,
  '.oga': 6,
  '.opus': 7,
  '.wma': 6,
  '.aac': 6,
  '.ape': 1.1,
  '.wv': 1.1
}

async function walkMusic(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > 10) return
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // Verborgen mappen en de "._"-schaduwbestanden van macOS zijn geen muziek.
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walkMusic(full, depth + 1, out)
    else {
      const ext = path.extname(entry.name).toLowerCase()
      if (PLAYER_FORMATS.has(ext) || ext in CONVERT_FORMATS) out.push(full)
    }
  }
}

/**
 * Zoekt alle muziek in een map die al op de computer staat. Leest alleen; de
 * map zelf wordt nooit aangeraakt.
 */
export async function scanMusicFolder(dir: string): Promise<FolderScan> {
  const paths: string[] = []
  await walkMusic(dir, 0, paths)
  paths.sort((a, b) => a.localeCompare(b))

  const files: FolderScan['files'] = []
  let bytes = 0
  for (const p of paths) {
    try {
      const size = (await fsp.stat(p)).size
      const growth = CONVERT_FORMATS[path.extname(p).toLowerCase()]
      files.push({ path: p, size, convert: growth !== undefined })
      bytes += Math.round(size * (growth ?? 1))
    } catch {
      /* net weggehaald */
    }
  }
  return { dir, files, bytes }
}

/**
 * Bestaande muziek heeft vaak geen tags, alleen een naam als
 * "03 - Artiest - Titel.mp3". Zonder dit zou alles op de stick in de map
 * "Onbekende artiest" belanden.
 */
export function guessFromFilename(file: string): { artist: string; title: string; trackNumber: string } {
  let stem = path.basename(file, path.extname(file)).trim()
  let trackNumber = ''
  // Alleen een tracknummer met voorloopnul of leesteken erachter, zodat
  // "50 Cent - In Da Club" en "3 Doors Down - Kryptonite" heel blijven.
  const nr = /^(0\d{1,2}|\d{1,3}(?=\s*[-._)]))\s*[-._)]?\s*(.+)$/.exec(stem)
  if (nr) {
    trackNumber = String(Number(nr[1]))
    stem = nr[2].trim()
  }
  const parts = /^(.+?)\s+[-–]\s+(.+)$/.exec(stem)
  return parts
    ? { artist: parts[1].trim(), title: parts[2].trim(), trackNumber }
    : { artist: '', title: stem, trackNumber }
}

/** Leest de tags terug uit het bestand zodat de export op echte metadata bouwt. */
async function metaOf(file: string): Promise<{ meta: TrackMeta; duration: number }> {
  const info = await mediaInfo(file)
  const t = info.tags
  const trackRaw = t.TRACK ?? t.TRACKNUMBER ?? ''
  // Alleen gokken als er helemaal geen tags zijn; echte tags gaan altijd voor.
  const guess = t.TITLE || t.ARTIST ? { artist: '', title: '', trackNumber: '' } : guessFromFilename(file)
  const meta: TrackMeta = {
    ...emptyMeta(),
    artist: t.ARTIST ?? guess.artist,
    title: t.TITLE ?? (guess.title || path.basename(file, path.extname(file))),
    album: t.ALBUM ?? '',
    albumArtist: t.ALBUM_ARTIST ?? t.ALBUMARTIST ?? t.ARTIST ?? '',
    genre: t.GENRE ?? '',
    year: (t.DATE ?? t.YEAR ?? '').slice(0, 4),
    trackNumber: trackRaw.split('/')[0] || guess.trackNumber,
    totalTracks: t.TRACKTOTAL ?? t.TOTALTRACKS ?? trackRaw.split('/')[1] ?? '',
    bpm: t.BPM ?? '',
    initialKey: t.INITIALKEY ?? t.KEY ?? '',
    label: t.LABEL ?? t.ORGANIZATION ?? '',
    comment: t.COMMENT ?? ''
  }
  return { meta, duration: info.duration }
}

/**
 * Zoekt in dir naar "base.ext" of "base (n).ext" met exact deze grootte.
 * Dat is de goedkoopste betrouwbare manier om te zien of dit nummer er al staat.
 * size null = alleen op naam: een omgezet bestand heeft nooit de grootte van de bron.
 */
async function findCopy(dir: string, base: string, ext: string, size: number | null): Promise<string | null> {
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return null
  }
  const prefix = base.toLowerCase()
  for (const name of names) {
    const lower = name.toLowerCase()
    if (!lower.endsWith(ext)) continue
    const stem = lower.slice(0, -ext.length)
    if (stem !== prefix && !/^ \(\d+\)$/.test(stem.slice(prefix.length))) continue
    if (!stem.startsWith(prefix)) continue
    const full = path.join(dir, name)
    try {
      if (size === null || (await fsp.stat(full)).size === size) return full
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

/** Zet om in een tijdelijke map en kopieert daarna met dezelfde fsync als copyFile. */
async function convertAndCopy(src: string, dest: string): Promise<number> {
  const temp = path.join(os.tmpdir(), 'flacdeck-omzetten', randomUUID() + '.flac')
  try {
    await convertToFlac(src, temp)
    return await copyFile(temp, dest)
  } finally {
    await fsp.rm(temp, { force: true })
  }
}

function fsWarnings(target: string, filesystem: string, layout: ExportLayout): string[] {
  const warnings: string[] = []
  const fsName = filesystem.toUpperCase()
  if (layout === 'dj') {
    if (fsName.includes('NTFS')) {
      warnings.push(
        'De stick is NTFS. Pioneer- en Denon-spelers lezen alleen FAT32 of exFAT — formatteer de stick opnieuw als FAT32.'
      )
    } else if (fsName.includes('APFS') || fsName.includes('HFS')) {
      warnings.push(
        'De stick is ' + filesystem + ' (Mac-formaat). DJ-spelers lezen dat niet — formatteer als FAT32 (MS-DOS).'
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
  (process.platform === 'darwin' ? MAC_STEPS : WINDOWS_EXPLORER_STEPS) + ' ' + ERASE_WARNING

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
      fix: 'Werkt de stick straks niet in de speler, maak hem dan opnieuw op als FAT32. ' + FORMAT_HELP
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
    junkRemoved: 0,
    converted: 0
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
      const srcExt = path.extname(src).toLowerCase()
      const convert = !PLAYER_FORMATS.has(srcExt)
      const ext = convert ? '.flac' : srcExt

      let dest: string
      if (req.overwrite) {
        dest = path.join(dir, base + ext)
        taken.add((base + ext).toLowerCase())
      } else {
        // Ook eerder hernoemde kopieën meenemen, anders groeit de stick bij elke
        // export aan met "(2)", "(3)", "(4)" van hetzelfde nummer.
        const srcSize = (await fsp.stat(src)).size
        const already = await findCopy(dir, base, ext, convert ? null : srcSize)
        if (already) {
          result.skipped += 1
          playlistEntries.push({
            relative: path.relative(req.target, already),
            absolute: already,
            size: convert ? (await fsp.stat(already)).size : srcSize,
            meta,
            duration
          })
          continue
        }
        dest = path.join(dir, uniqueName(base, ext, taken))
      }

      const written = convert ? await convertAndCopy(src, dest) : await copyFile(src, dest)
      if (convert) result.converted += 1
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
