/**
 * Test de USB-export: mapindelingen, botsende namen, playlist en de
 * waarschuwing over het bestandssysteem. Gebruikt echte FLAC-bestanden die
 * ffmpeg hier ter plekke maakt, zodat de tags echt uit de bestanden komen.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { ffmpegPath } from '../electron/services/binaries'
import {
  checkDrive,
  cleanupDrive,
  ejectDrive,
  exportTracks,
  guessFromFilename,
  layoutOptions,
  listDrives,
  parseMacUnreadable,
  parseWindowsUnreadable,
  scanMusicFolder
} from '../electron/services/usb'

const work = path.join(os.tmpdir(), 'flacdeck-test', 'usb')
const srcDir = path.join(work, 'bron')
const dstDir = path.join(work, 'stick')

let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log('ok    ' + name)
  else {
    fail += 1
    console.log('FAIL  ' + name + (detail ? ' — ' + detail : ''))
  }
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-400)))))
  })
}

async function makeFlac(file: string, meta: Record<string, string>, duration = 2): Promise<void> {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + duration,
    '-c:a', 'flac', '-compression_level', '0'
  ]
  for (const [k, v] of Object.entries(meta)) args.push('-metadata', k + '=' + v)
  args.push(file)
  await ffmpeg(args)
}

/** Alle bestandspaden onder een map, relatief en met / als scheidingsteken. */
function tree(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tree(full, base))
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out.sort()
}

async function main(): Promise<void> {
  await fsp.rm(work, { recursive: true, force: true })
  await fsp.mkdir(srcDir, { recursive: true })

  const a = path.join(srcDir, 'a.flac')
  const b = path.join(srcDir, 'b.flac')
  const c = path.join(srcDir, 'c.flac')
  await makeFlac(a, {
    ARTIST: 'Sigur Rós', TITLE: 'Glósóli', ALBUM: 'Takk...', ALBUMARTIST: 'Sigur Rós',
    GENRE: 'Post-rock', DATE: '2005', TRACKNUMBER: '2'
  })
  await makeFlac(b, {
    ARTIST: 'AC/DC', TITLE: 'Back in Black', ALBUM: 'Back in Black', ALBUMARTIST: 'AC/DC',
    GENRE: 'Rock', DATE: '1980', TRACKNUMBER: '1'
  })
  // Zelfde tags als a maar andere inhoud (live-versie): moet een eigen naam krijgen
  // in plaats van a te overschrijven of als duplicaat te worden overgeslagen.
  await makeFlac(c, {
    ARTIST: 'Sigur Rós', TITLE: 'Glósóli', ALBUM: 'Takk...', ALBUMARTIST: 'Sigur Rós',
    GENRE: 'Post-rock', DATE: '2005', TRACKNUMBER: '2'
  }, 3)

  const paths = [a, b, c]

  check('layoutOptions geeft vier indelingen', layoutOptions().length === 4)
  check(
    'dj-indeling staat vooraan',
    layoutOptions()[0].id === 'dj',
    layoutOptions()[0].id
  )

  /* --------------------------- dj-indeling ------------------------------- */

  const djDir = path.join(dstDir, 'dj')
  await fsp.mkdir(djDir, { recursive: true })
  const dj = await exportTracks({
    paths, target: djDir, layout: 'dj', asciiNames: false,
    createM3u: true, playlistName: 'Mijn set', overwrite: false
  })

  check('drie bestanden gekopieerd', dj.copied === 3, String(dj.copied))
  check('niets mislukt', dj.failed.length === 0, JSON.stringify(dj.failed))
  check('bytes geteld', dj.bytes > 0, String(dj.bytes))

  const djTree = tree(djDir)
  check(
    'Contents/Artiest/Album-structuur',
    djTree.includes('Contents/Sigur Rós/Takk/02 Sigur Rós - Glósóli.flac'),
    djTree.join(' | ')
  )
  check(
    'schuine streep in artiestnaam onschadelijk gemaakt',
    djTree.some((f) => f.startsWith('Contents/AC-DC/')),
    djTree.join(' | ')
  )
  check(
    'dubbele titel krijgt eigen naam',
    djTree.some((f) => f.includes('Glósóli (2).flac')),
    djTree.join(' | ')
  )
  check('playlist geschreven', dj.playlistPath !== null && fs.existsSync(dj.playlistPath))

  const m3u = fs.readFileSync(path.join(djDir, 'Mijn set.m3u8'), 'utf8')
  check('playlist begint met #EXTM3U', m3u.startsWith('#EXTM3U'))
  check('playlist heeft EXTINF met duur', /#EXTINF:2,Sigur Rós - Glósóli/.test(m3u), m3u.split('\n')[1])
  check('playlist gebruikt relatieve paden met /', m3u.includes('Contents/Sigur R'))

  /* ------------------------- terugtellen op de stick ----------------------- */

  check('alle drie teruggevonden op de stick', dj.verified === 3, String(dj.verified))
  check('niets zoekgeraakt', dj.missing.length === 0, dj.missing.join(' | '))

  // Wat er niet aankwam moet gemeld worden, niet stilletjes als "gekopieerd"
  // blijven staan: precies de melding die een halfgeschreven stick verraadt.
  const weg = path.join(djDir, 'Contents', 'AC-DC', 'Back in Black')
  const voorWeghalen = tree(weg, weg)
  await fsp.rm(path.join(weg, voorWeghalen[0]), { force: true })
  const naControle = await exportTracks({
    paths: [b], target: djDir, layout: 'dj', asciiNames: false,
    createM3u: false, playlistName: '', overwrite: false
  })
  check('een weggehaald bestand wordt opnieuw gekopieerd', naControle.copied === 1, String(naControle.copied))

  /* ---------------------- macOS-rommel en controle vooraf ------------------ */

  const junkDir = path.join(dstDir, 'junk')
  await fsp.mkdir(path.join(junkDir, '.Spotlight-V100'), { recursive: true })
  await fsp.writeFile(path.join(junkDir, '._Glosoli.flac'), 'appledouble')
  await fsp.writeFile(path.join(junkDir, '.DS_Store'), 'finder')
  await fsp.writeFile(path.join(junkDir, 'desktop.ini'), '[.ShellClassInfo]')
  // Een gewone map is niet verwisselbaar, dus er hoort niets te gebeuren.
  const opgeruimd = await cleanupDrive(junkDir)
  check('ruimt niets op buiten een verwisselbare stick', opgeruimd === 0, String(opgeruimd))
  check(
    'laat desktop.ini met rust',
    fs.existsSync(path.join(junkDir, 'desktop.ini'))
  )

  const wegCheck = await checkDrive(path.join(dstDir, 'bestaat-niet'), 'dj')
  check('meldt een stick die er niet is', wegCheck.level === 'block', wegCheck.title)
  check('geeft er ook bij wat de gebruiker moet doen', Boolean(wegCheck.fix), wegCheck.fix)

  const leegCheck = await checkDrive('', 'dj')
  check('meldt dat er nog niets gekozen is', leegCheck.level === 'block', leegCheck.title)

  // Uitwerpen mag nooit op een vaste schijf terechtkomen: wie in de
  // geavanceerde modus een gewone map koos, zou zijn systeemschijf aanbieden.
  const vast = await ejectDrive(djDir)
  check('werpt geen vaste schijf uit', vast.ok === false, vast.message)
  check('legt uit waarom niet', /vaste schijf|niet bij een schijf/.test(vast.message), vast.message)

  /* ------------------------- overslaan en opnieuw -------------------------- */

  const again = await exportTracks({
    paths, target: djDir, layout: 'dj', asciiNames: false,
    createM3u: false, playlistName: '', overwrite: false
  })
  check('tweede keer wordt overgeslagen', again.skipped === 3 && again.copied === 0,
    'gekopieerd=' + again.copied + ' overgeslagen=' + again.skipped)

  /* ---------------------------- auto-indeling ----------------------------- */

  const carDir = path.join(dstDir, 'auto')
  await fsp.mkdir(carDir, { recursive: true })
  await exportTracks({
    paths: [a], target: carDir, layout: 'car', asciiNames: false,
    createM3u: false, playlistName: '', overwrite: false
  })
  const carTree = tree(carDir)
  check(
    'auto-indeling forceert ascii',
    carTree.includes('Music/Sigur Ros/Takk/02 - Glosoli.flac'),
    carTree.join(' | ')
  )

  /* ------------------------------ platte map ------------------------------ */

  const flatDir = path.join(dstDir, 'plat')
  await fsp.mkdir(flatDir, { recursive: true })
  await exportTracks({
    paths: [b], target: flatDir, layout: 'flat', asciiNames: false,
    createM3u: false, playlistName: '', overwrite: false
  })
  check('platte indeling zonder submappen', tree(flatDir).join() === 'AC-DC - Back in Black.flac', tree(flatDir).join())

  /* ---------------------------- bibliotheek ------------------------------- */

  const libDir = path.join(dstDir, 'bieb')
  await fsp.mkdir(libDir, { recursive: true })
  await exportTracks({
    paths: [b], target: libDir, layout: 'library', asciiNames: false,
    createM3u: false, playlistName: '', overwrite: false
  })
  check(
    'bibliotheek sorteert op genre',
    tree(libDir).includes('Muziek/Rock/AC-DC/Back in Black/01 - Back in Black.flac'),
    tree(libDir).join(' | ')
  )

  /* ----------------------- bestaande muziek uit een map --------------------- */

  const raad = (naam: string): string => JSON.stringify(guessFromFilename(naam))
  check('naam: nummer, artiest en titel', raad('03 - Daft Punk - One More Time.mp3') ===
    JSON.stringify({ artist: 'Daft Punk', title: 'One More Time', trackNumber: '3' }), raad('03 - Daft Punk - One More Time.mp3'))
  check('naam: "01. Titel" zonder artiest', raad('01. Intro.mp3') ===
    JSON.stringify({ artist: '', title: 'Intro', trackNumber: '1' }), raad('01. Intro.mp3'))
  check('naam: 50 Cent blijft een artiest', raad('50 Cent - In Da Club.mp3') ===
    JSON.stringify({ artist: '50 Cent', title: 'In Da Club', trackNumber: '' }), raad('50 Cent - In Da Club.mp3'))
  check('naam: 1999 blijft een titel', raad('1999.mp3') ===
    JSON.stringify({ artist: '', title: '1999', trackNumber: '' }), raad('1999.mp3'))

  const mijnMap = path.join(work, 'eigen muziek')
  await fsp.mkdir(path.join(mijnMap, 'Album'), { recursive: true })
  const mp3 = path.join(mijnMap, 'Album', '02 - Moby - Porcelain.mp3')
  const ogg = path.join(mijnMap, 'Underworld - Born Slippy.ogg')
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:a', 'libmp3lame', '-b:a', '128k', mp3])
  await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=2', '-c:a', 'libvorbis', ogg])
  await fsp.writeFile(path.join(mijnMap, 'hoes.jpg'), 'geen muziek')
  await fsp.writeFile(path.join(mijnMap, 'Album', '._02 - Moby - Porcelain.mp3'), 'appledouble')
  const mp3Voor = fs.readFileSync(mp3)

  const scan = await scanMusicFolder(mijnMap)
  check('map: twee nummers gevonden, ook in submap', scan.files.length === 2, scan.files.map((f) => f.path).join(' | '))
  check('map: ogg wordt omgezet, mp3 niet',
    scan.files.find((f) => f.path === ogg)?.convert === true && scan.files.find((f) => f.path === mp3)?.convert === false)

  const denonDir = path.join(dstDir, 'denon')
  await fsp.mkdir(denonDir, { recursive: true })
  const denon = await exportTracks({
    paths: scan.files.map((f) => f.path), target: denonDir, layout: 'dj', asciiNames: false,
    createM3u: false, playlistName: '', overwrite: false
  })
  const denonTree = tree(denonDir)
  check('map: niets mislukt', denon.failed.length === 0, JSON.stringify(denon.failed))
  check('map: mp3 blijft mp3, met naam uit de bestandsnaam',
    denonTree.includes('Contents/Moby/02 Moby - Porcelain.mp3'), denonTree.join(' | '))
  check('map: ogg is FLAC geworden', denonTree.includes('Contents/Underworld/Underworld - Born Slippy.flac'), denonTree.join(' | '))
  check('map: één bestand omgezet', denon.converted === 1, String(denon.converted))
  check('map: beide teruggevonden op de stick', denon.verified === 2, String(denon.verified))
  check('map: origineel onaangeroerd', fs.readFileSync(mp3).equals(mp3Voor) && fs.existsSync(ogg))

  const denonWeer = await exportTracks({
    paths: scan.files.map((f) => f.path), target: denonDir, layout: 'dj', asciiNames: false,
    createM3u: false, playlistName: '', overwrite: false
  })
  check('map: tweede keer alles overgeslagen, ook het omgezette',
    denonWeer.skipped === 2 && denonWeer.copied === 0, 'gekopieerd=' + denonWeer.copied + ' overgeslagen=' + denonWeer.skipped)

  /* ------------------------------- schijven -------------------------------- */

  const drives = await listDrives()
  check('schijven gevonden', drives.length > 0, String(drives.length))
  check('schijf heeft pad en bestandssysteem', drives.every((d) => Boolean(d.path)), JSON.stringify(drives[0]))
  const ntfs = drives.find((d) => d.filesystem.toUpperCase().includes('NTFS'))
  if (ntfs) {
    const warned = await exportTracks({
      paths: [], target: ntfs.path, layout: 'dj', asciiNames: false,
      createM3u: false, playlistName: '', overwrite: false
    })
    check(
      'waarschuwt dat een dj-speler geen NTFS leest',
      warned.warnings.some((w) => w.includes('NTFS')),
      warned.warnings.join(' | ')
    )
  } else {
    console.log('ok    (geen NTFS-schijf om de waarschuwing op te testen)')
  }

  /* ------------------- sticks die erin zitten maar dicht ------------------- */

  // Zoals Windows een op de Mac gewiste stick ziet: één APFS-partitie, geen letter.
  const winMac = parseWindowsUnreadable([
    {
      Name: 'HEMA_16G HEMA_16GB',
      Size: 15525216256,
      Parts: [{ Letter: '\u0000', Gpt: '{7c3457ef-0000-11aa-aa11-00306543ecac}', Mbr: '', Fs: '' }]
    }
  ])
  check('Windows: Mac-stick gemeld', winMac.length === 1 && winMac[0].kind === 'mac', JSON.stringify(winMac))
  check('Windows: Mac-stick krijgt uitleg voor de Mac', /Schijfhulpprogramma/.test(winMac[0]?.fix ?? ''))

  const winOk = parseWindowsUnreadable([
    { Name: 'SanDisk', Size: 32e9, Parts: [{ Letter: 'E', Gpt: '', Mbr: '12', Fs: 'FAT32' }] }
  ])
  check('Windows: leesbare stick niet gemeld', winOk.length === 0, JSON.stringify(winOk))

  const winLeeg = parseWindowsUnreadable({ Name: 'Kingston', Size: 8e9, Parts: [] })
  check('Windows: lege stick gemeld als niet opgemaakt', winLeeg[0]?.kind === 'leeg', JSON.stringify(winLeeg))

  const winHfsMbr = parseWindowsUnreadable([
    { Name: 'Oud', Size: 4e9, Parts: [{ Letter: '', Gpt: '', Mbr: '175', Fs: '' }] }
  ])
  check('Windows: HFS+ op MBR is ook Mac-formaat', winHfsMbr[0]?.kind === 'mac', JSON.stringify(winHfsMbr))

  const winExt = parseWindowsUnreadable([
    { Name: 'Raspberry', Size: 16e9, Parts: [{ Letter: '', Gpt: '{0fc63daf-8483-4772-8e79-3d69d8477de4}', Mbr: '', Fs: '' }] }
  ])
  check('Windows: Linux-stick is onbekend', winExt[0]?.kind === 'onbekend', JSON.stringify(winExt))

  // diskutil list -plist external physical, omgezet naar JSON.
  const macLijst = parseMacUnreadable({
    AllDisksAndPartitions: [
      {
        DeviceIdentifier: 'disk4', Size: 16e9, Content: 'FDisk_partition_scheme',
        Partitions: [{ DeviceIdentifier: 'disk4s1', Content: 'DOS_FAT_32', MountPoint: '/Volumes/MUZIEK' }]
      },
      {
        DeviceIdentifier: 'disk5', Size: 16e9, Content: 'GUID_partition_scheme',
        Partitions: [{ Content: 'EFI' }, { DeviceIdentifier: 'disk5s2', Content: 'Apple_APFS' }]
      },
      {
        DeviceIdentifier: 'disk6', Size: 8e9, Content: 'FDisk_partition_scheme',
        Partitions: [{ DeviceIdentifier: 'disk6s1', Content: 'Windows_FAT_32' }]
      },
      { DeviceIdentifier: 'disk7', Size: 8e9, Content: '', Partitions: [] },
      {
        DeviceIdentifier: 'disk8', Size: 16e9, Content: 'GUID_partition_scheme',
        Partitions: [{ Content: 'EFI' }, { DeviceIdentifier: 'disk8s2', Content: 'Linux Filesystem' }]
      },
      { DeviceIdentifier: 'disk9', Size: 0, Content: '' }
    ]
  })
  const macSoort = Object.fromEntries(macLijst.map((s) => [s.name, s.kind]))
  check('Mac: aangekoppelde stick niet gemeld', !('disk4' in macSoort), JSON.stringify(macSoort))
  check('Mac: APFS laat hij aan checkDrive over', !('disk5' in macSoort), JSON.stringify(macSoort))
  check('Mac: FAT-stick zonder koppeling is uitgeworpen', macSoort.disk6 === 'uitgeworpen', JSON.stringify(macSoort))
  check('Mac: stick zonder indeling is niet opgemaakt', macSoort.disk7 === 'leeg', JSON.stringify(macSoort))
  check('Mac: Linux-stick is onbekend', macSoort.disk8 === 'onbekend', JSON.stringify(macSoort))
  check('Mac: lege kaartlezer niet gemeld', !('disk9' in macSoort), JSON.stringify(macSoort))

  await fsp.rm(work, { recursive: true, force: true })
}

main()
  .then(() => {
    console.log(fail ? '\n' + fail + ' mislukt' : '\nalles geslaagd')
    process.exit(fail ? 1 : 0)
  })
  .catch((err: Error) => {
    console.error('\nafgebroken:', err.message)
    process.exit(1)
  })
