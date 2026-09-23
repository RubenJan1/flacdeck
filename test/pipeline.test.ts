/**
 * End-to-end test van de echte downloadketen: yt-dlp haalt een korte publieke
 * video op, ffmpeg knipt er een stuk uit en schrijft een getagde FLAC.
 * Draait tegen het netwerk; sla 'm over met SKIP_NETWORK=1.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { encodeFlac, mediaInfo, prepareCover } from '../electron/services/audio'
import { downloadAudio, downloadThumbnail, probe } from '../electron/services/ytdlp'
import { ensureYtdlp } from '../electron/services/binaries'
import { emptyMeta, type Settings } from '../shared/types'

const URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const work = path.join(os.tmpdir(), 'flacdeck-test', 'pipeline')

const settings: Settings = {
  simpleMode: true,
  outputDir: work,
  naming: '{artist} - {title}',
  concurrency: 2,
  audio: {
    compression: 5,
    sampleRate: '44100',
    bitDepth: '16',
    channels: 'stereo',
    normalize: false,
    targetLufs: -14,
    fadeIn: 0,
    fadeOut: 0
  },
  usb: { layout: 'dj', asciiNames: false, createM3u: true },
  cookiesFromBrowser: '',
  proxy: '',
  keepSource: false
}

let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log('ok    ' + name)
  else {
    fail += 1
    console.log('FAIL  ' + name + (detail ? ' — ' + detail : ''))
  }
}

async function main(): Promise<void> {
  if (process.env.SKIP_NETWORK) {
    console.log('netwerk overgeslagen')
    return
  }
  await fsp.rm(work, { recursive: true, force: true })
  await fsp.mkdir(work, { recursive: true })

  let lastStep = -1
  const step = (label: string) => (p: number): void => {
    const bucket = Math.floor(p / 25)
    if (bucket !== lastStep) {
      lastStep = bucket
      console.log('      ' + label + ' ' + Math.round(p) + '%')
    }
  }

  await ensureYtdlp(step('yt-dlp ophalen'))
  lastStep = -1

  const info = await probe(URL, settings)
  check('probe geeft titel', info.title === 'Me at the zoo', info.title)
  check('probe geeft duur', info.duration === 19, String(info.duration))
  check('probe herkent geen live', !info.isLive && !info.wasLive)
  check('probe geeft thumbnail', info.thumbnail.startsWith('http'))
  check('probe stelt segmenten voor', info.suggestedSegments.length >= 1)

  const source = await downloadAudio({
    url: info.webpageUrl,
    outDir: work,
    outBase: 'source',
    settings,
    onProgress: step('downloaden')
  })
  check('bron gedownload', fs.existsSync(source), source)

  const srcInfo = await mediaInfo(source)
  check('bron heeft volledige duur', Math.abs(srcInfo.duration - 19) < 1.5, String(srcInfo.duration))

  const thumb = await downloadThumbnail(info.thumbnail, path.join(work, 'thumb.img'))
  const cover = await prepareCover(thumb, path.join(work, 'cover.jpg'), true)
  check('cover voorbereid', fs.existsSync(cover))

  const out = path.join(work, 'geknipt.flac')
  const result = await encodeFlac({
    input: source,
    output: out,
    start: 5,
    end: 12,
    cover,
    audio: settings.audio,
    meta: {
      ...emptyMeta(),
      artist: 'Testartiest',
      title: 'Geknipt stuk',
      album: 'Testalbum',
      albumArtist: 'Testartiest',
      genre: 'Spoken',
      year: '2005',
      trackNumber: '2',
      totalTracks: '5',
      bpm: '120',
      initialKey: '8A',
      label: 'Testlabel'
    }
  })

  check('exact 7 seconden geknipt', Math.abs(result.duration - 7) < 0.15, String(result.duration))
  check('bestand heeft inhoud', result.size > 10_000, String(result.size))

  const outInfo = await mediaInfo(out)
  check('flac op 44100 Hz', outInfo.sampleRate === 44100, String(outInfo.sampleRate))
  check('stereo', outInfo.channels === 2, String(outInfo.channels))
  check('codec is flac', outInfo.codec === 'flac', outInfo.codec)

  // Vorbis-comments rechtstreeks uit het bestand lezen: ffprobe hernoemt keys.
  // Veldnamen zijn hoofdletterongevoelig volgens de Vorbis-spec; ffmpeg schrijft
  // de bekende velden in kleine letters en onbekende zoals aangeleverd.
  const tags = readVorbis(out).map((t) => t.toUpperCase())
  for (const expected of [
    'ARTIST=TESTARTIEST',
    'TITLE=GEKNIPT STUK',
    'ALBUMARTIST=TESTARTIEST',
    'TRACKNUMBER=2',
    'TRACKTOTAL=5',
    'BPM=120',
    'INITIALKEY=8A',
    'ORGANIZATION=TESTLABEL',
    'ENCODEDBY=FLACDECK'
  ]) {
    const [key] = expected.split('=')
    check('tag ' + key, tags.includes(expected), tags.find((t) => t.startsWith(key + '=')) ?? 'ontbreekt')
  }
  check('cover ingebed', hasPictureBlock(out))

  const whole = path.join(work, 'heel.flac')
  const wholeResult = await encodeFlac({
    input: source,
    output: whole,
    start: null,
    end: null,
    cover: null,
    audio: { ...settings.audio, sampleRate: 'source', bitDepth: 'source', channels: 'source' },
    meta: { ...emptyMeta(), artist: 'A', title: 'Hele video' }
  })
  check('hele bron omgezet', Math.abs(wholeResult.duration - 19) < 1.5, String(wholeResult.duration))
  check('zonder cover geen picture-blok', !hasPictureBlock(whole))

  await fsp.rm(work, { recursive: true, force: true })
}

/** Loopt de FLAC-metadatablokken af en geeft de Vorbis-comments terug. */
function blocks(file: string): { type: number; body: Buffer }[] {
  const buf = fs.readFileSync(file)
  const out: { type: number; body: Buffer }[] = []
  let off = 4
  for (;;) {
    const header = buf[off]
    const last = (header & 0x80) !== 0
    const type = header & 0x7f
    const len = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]
    out.push({ type, body: buf.subarray(off + 4, off + 4 + len) })
    off += 4 + len
    if (last || off >= buf.length) break
  }
  return out
}

function readVorbis(file: string): string[] {
  const block = blocks(file).find((b) => b.type === 4)
  if (!block) return []
  const body = block.body
  let p = 0
  p += 4 + body.readUInt32LE(p)
  const count = body.readUInt32LE(p)
  p += 4
  const tags: string[] = []
  for (let i = 0; i < count; i += 1) {
    const len = body.readUInt32LE(p)
    p += 4
    tags.push(body.subarray(p, p + len).toString('utf8'))
    p += len
  }
  return tags
}

function hasPictureBlock(file: string): boolean {
  return blocks(file).some((b) => b.type === 6)
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
