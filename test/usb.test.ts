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
  layoutOptions,
  listDrives
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
