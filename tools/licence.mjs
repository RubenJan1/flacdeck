#!/usr/bin/env node
/**
 * Sleutelbeheer voor FlacDeck.
 *
 *   node tools/licence.mjs init
 *       Maakt eenmalig een sleutelpaar. De geheime helft komt in keys/private.pem
 *       (staat in .gitignore), de publieke helft wordt in shared/licence-key.ts
 *       gezet en gaat dus mee de app in.
 *
 *   node tools/licence.mjs issue --naam "Jan Jansen" [--email jan@x.nl]
 *                                [--verloopt 2027-01-01] [--notitie "vriend"]
 *       Geeft een sleutel uit en schrijft hem bij in keys/uitgegeven.csv.
 *
 *   node tools/licence.mjs verify <sleutel>
 *       Controleert een sleutel zoals de app dat doet.
 *
 *   node tools/licence.mjs list
 *       Toont wat je tot nu toe hebt uitgegeven.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// De tests draaien dit met een eigen wegwerpsleutelpaar in een tijdelijke map,
// zodat ze niet afhankelijk zijn van keys/ — dat staat immers niet in git.
const keysDir = process.env.FLACDECK_KEYS_DIR
  ? path.resolve(process.env.FLACDECK_KEYS_DIR)
  : path.join(root, 'keys')
const privatePath = path.join(keysDir, 'private.pem')
const ledgerPath = path.join(keysDir, 'uitgegeven.csv')
const publicKeyModule = process.env.FLACDECK_PUBKEY_OUT
  ? path.resolve(process.env.FLACDECK_PUBKEY_OUT)
  : path.join(root, 'shared', 'licence-key.ts')

const PREFIX = 'FD1'

/* ------------------------------ hulpmiddelen ------------------------------ */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

function args(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        i += 1
      }
    } else out._.push(a)
  }
  return out
}

function die(message) {
  console.error('\n  ' + message + '\n')
  process.exit(1)
}

/** Korte, uitspreekbare id zonder tekens die je kunt verwarren. */
function shortId() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  const bytes = crypto.randomBytes(8)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out.slice(0, 4) + '-' + out.slice(4, 8)
}

/* --------------------------------- init ---------------------------------- */

function init(opts) {
  if (fs.existsSync(privatePath) && !opts.force) {
    die(
      'Er bestaat al een sleutelpaar (keys/private.pem).\n' +
        '  Een nieuw paar maakt ALLE eerder uitgegeven sleutels ongeldig.\n' +
        '  Weet je het zeker? Gebruik --force.'
    )
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.mkdirSync(keysDir, { recursive: true })
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })

  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  fs.writeFileSync(
    publicKeyModule,
    '/**\n' +
      ' * Publieke sleutel waarmee de app licentiesleutels controleert.\n' +
      ' * Gegenereerd door tools/licence.mjs init — niet met de hand aanpassen.\n' +
      ' * De bijbehorende geheime sleutel staat in keys/private.pem en hoort\n' +
      ' * NOOIT in git. Raak je die kwijt, dan kun je geen nieuwe sleutels meer\n' +
      ' * uitgeven (bestaande blijven werken).\n' +
      ' */\n' +
      'export const LICENCE_PUBLIC_KEY = `' +
      pem.trim() +
      '`\n',
    'utf8'
  )

  console.log('\n  Sleutelpaar aangemaakt.')
  console.log('  Geheim:   keys/private.pem      (staat in .gitignore — bewaar een back-up!)')
  console.log('  Publiek:  shared/licence-key.ts (gaat mee de app in)\n')
}

/* --------------------------------- issue --------------------------------- */

function loadPrivateKey() {
  if (!fs.existsSync(privatePath)) {
    die('Nog geen sleutelpaar. Draai eerst:  npm run licence:init')
  }
  return crypto.createPrivateKey(fs.readFileSync(privatePath))
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload))
  const signature = crypto.sign(null, Buffer.from(PREFIX + '.' + body), loadPrivateKey())
  return PREFIX + '.' + body + '.' + b64url(signature)
}

function issue(opts) {
  const naam = opts.naam ?? opts.name
  if (!naam || naam === true) die('Geef een naam op:  node tools/licence.mjs issue --naam "Jan Jansen"')

  const verloopt = opts.verloopt ?? opts.expires
  if (verloopt && verloopt !== true && !/^\d{4}-\d{2}-\d{2}$/.test(verloopt)) {
    die('Verloopdatum moet als JJJJ-MM-DD, bijvoorbeeld 2027-01-01.')
  }

  const payload = {
    v: 1,
    id: shortId(),
    n: String(naam),
    iat: new Date().toISOString().slice(0, 10)
  }
  const email = opts.email
  if (email && email !== true) payload.e = String(email)
  if (verloopt && verloopt !== true) payload.exp = verloopt

  const key = sign(payload)

  // De tests geven echte sleutels uit; die horen niet in je administratie.
  if (process.env.FLACDECK_LICENCE_LEDGER === 'off') {
    console.log('\n' + key + '\n')
    return
  }

  fs.mkdirSync(keysDir, { recursive: true })
  if (!fs.existsSync(ledgerPath)) {
    fs.writeFileSync(ledgerPath, 'id,naam,email,uitgegeven,verloopt,notitie\n', 'utf8')
  }
  const csv = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"'
  fs.appendFileSync(
    ledgerPath,
    [
      csv(payload.id),
      csv(payload.n),
      csv(payload.e ?? ''),
      csv(payload.iat),
      csv(payload.exp ?? 'onbeperkt'),
      csv(opts.notitie === true ? '' : opts.notitie ?? '')
    ].join(',') + '\n',
    'utf8'
  )

  console.log('\n  Sleutel voor ' + payload.n + '  (' + payload.id + ')')
  console.log('  Geldig tot: ' + (payload.exp ?? 'onbeperkt'))
  console.log('\n' + key + '\n')
  console.log('  Bijgeschreven in keys/uitgegeven.csv\n')
}

/* --------------------------------- verify -------------------------------- */

function publicKeyFromModule() {
  if (!fs.existsSync(publicKeyModule)) die('shared/licence-key.ts ontbreekt. Draai:  npm run licence:init')
  const source = fs.readFileSync(publicKeyModule, 'utf8')
  const match = source.match(/`([\s\S]*?)`/)
  if (!match) die('Kon de publieke sleutel niet uit shared/licence-key.ts lezen.')
  return crypto.createPublicKey(match[1].trim() + '\n')
}

function verify(raw) {
  const cleaned = String(raw ?? '').replace(/\s+/g, '')
  const parts = cleaned.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: 'Dit ziet er niet uit als een FlacDeck-sleutel.' }

  let payload
  try {
    payload = JSON.parse(fromB64url(parts[1]).toString('utf8'))
  } catch {
    return { ok: false, reason: 'De sleutel is beschadigd.' }
  }

  const valid = crypto.verify(
    null,
    Buffer.from(PREFIX + '.' + parts[1]),
    publicKeyFromModule(),
    fromB64url(parts[2])
  )
  if (!valid) return { ok: false, reason: 'De handtekening klopt niet.' }
  if (payload.exp && payload.exp < new Date().toISOString().slice(0, 10)) {
    return { ok: false, reason: 'Deze sleutel is verlopen op ' + payload.exp + '.' }
  }
  return { ok: true, payload }
}

/* ---------------------------------- cli ---------------------------------- */

const opts = args(process.argv.slice(2))
const command = opts._[0]

if (command === 'init') init(opts)
else if (command === 'issue') issue(opts)
else if (command === 'verify') {
  const result = verify(opts._[1])
  if (result.ok) {
    console.log('\n  Geldig — ' + result.payload.n + ' (' + result.payload.id + ')')
    console.log('  Geldig tot: ' + (result.payload.exp ?? 'onbeperkt') + '\n')
  } else {
    console.log('\n  Ongeldig — ' + result.reason + '\n')
    process.exit(1)
  }
} else if (command === 'list') {
  if (!fs.existsSync(ledgerPath)) die('Nog niets uitgegeven.')
  console.log('\n' + fs.readFileSync(ledgerPath, 'utf8'))
} else {
  console.log(
    [
      '',
      '  node tools/licence.mjs init',
      '  node tools/licence.mjs issue --naam "Jan Jansen" [--email x@y.nl] [--verloopt 2027-01-01] [--notitie "..."]',
      '  node tools/licence.mjs verify <sleutel>',
      '  node tools/licence.mjs list',
      ''
    ].join('\n')
  )
}
