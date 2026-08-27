// Genereert build/icon.png (1024x1024) zonder externe libraries.
// electron-builder maakt hier zelf .ico en .icns van.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SIZE = 1024
const RADIUS = 224

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

/** Afstand tot een afgerond vierkant; negatief = binnen. */
function roundedDistance(x, y, size, radius) {
  const cx = Math.abs(x - size / 2) - (size / 2 - radius)
  const cy = Math.abs(y - size / 2) - (size / 2 - radius)
  const dx = Math.max(cx, 0)
  const dy = Math.max(cy, 0)
  return Math.min(Math.max(cx, cy), 0) + Math.hypot(dx, dy) - radius
}

const TOP = [255, 190, 70]
const BOTTOM = [235, 88, 40]
const INK = [26, 18, 5]

const rows = []
for (let y = 0; y < SIZE; y += 1) {
  const row = Buffer.alloc(SIZE * 4 + 1)
  row[0] = 0 // filter: none
  for (let x = 0; x < SIZE; x += 1) {
    const d = roundedDistance(x, y, SIZE, RADIUS)
    const alpha = Math.max(0, Math.min(1, 0.5 - d)) * 255
    let [r, g, b] = mix(TOP, BOTTOM, (x / SIZE) * 0.35 + (y / SIZE) * 0.65)

    // Vier staven op een basislijn: een simpele level-meter.
    const nx = x / SIZE
    const ny = y / SIZE
    const BASE = 0.72
    const bars = [
      { cx: 0.3, top: 0.46 },
      { cx: 0.435, top: 0.28 },
      { cx: 0.57, top: 0.38 },
      { cx: 0.705, top: 0.52 }
    ]
    for (const bar of bars) {
      if (Math.abs(nx - bar.cx) < 0.045 && ny > bar.top && ny < BASE) [r, g, b] = INK
    }
    if (ny > BASE + 0.035 && ny < BASE + 0.075 && nx > 0.25 && nx < 0.75) [r, g, b] = INK

    const i = 1 + x * 4
    row[i] = r
    row[i + 1] = g
    row[i + 2] = b
    row[i + 3] = Math.round(alpha)
  }
  rows.push(row)
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crcBuf])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bitdiepte
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icon.png')
writeFileSync(out, png)
console.log('geschreven:', out, png.length, 'bytes')
