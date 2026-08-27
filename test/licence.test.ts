/**
 * Controleert dat de sleutelcontrole doet wat hij moet doen: echte sleutels
 * toelaten, en geknoei, namaak en verlopen sleutels weigeren.
 */
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { verifyKey } from '../electron/services/licence'

const root = path.resolve(__dirname, '..')

let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log('ok    ' + name)
  else {
    fail += 1
    console.log('FAIL  ' + name + (detail ? ' — ' + detail : ''))
  }
}

/** Geeft een echte sleutel uit met het meegeleverde gereedschap. */
function issue(extra: string[] = []): string {
  const out = execFileSync(
    process.execPath,
    [path.join(root, 'tools', 'licence.mjs'), 'issue', '--naam', 'Testgebruiker', ...extra],
    { encoding: 'utf8', env: { ...process.env, FLACDECK_LICENCE_LEDGER: 'off' } }
  )
  const key = out.split(/\r?\n/).find((l) => l.startsWith('FD1.'))
  if (!key) throw new Error('geen sleutel in de uitvoer:\n' + out)
  return key.trim()
}

const good = issue()

check('geldige sleutel wordt geaccepteerd', verifyKey(good).valid)
check('naam komt terug', verifyKey(good).info?.name === 'Testgebruiker', verifyKey(good).info?.name)
check('id komt terug', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(verifyKey(good).info?.id ?? ''), verifyKey(good).info?.id)
check('zonder verloopdatum onbeperkt', verifyKey(good).info?.expires === '')

check('spaties en regeleindes storen niet', verifyKey('  ' + good.slice(0, 20) + '\n' + good.slice(20) + '  ').valid)

/* ------------------------------- weigeren -------------------------------- */

check('lege invoer', !verifyKey('').valid)
check('willekeurige tekst', !verifyKey('geef mij toegang').valid)
check('verkeerd voorvoegsel', !verifyKey(good.replace('FD1.', 'FD2.')).valid)
check('te weinig delen', !verifyKey('FD1.abc').valid)

// Naam veranderen zonder de handtekening opnieuw te zetten moet stuklopen.
const [prefix, body, sig] = good.split('.')
const payload = JSON.parse(
  Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
) as Record<string, unknown>
payload.n = 'Iemand anders'
const tamperedBody = Buffer.from(JSON.stringify(payload))
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')
check('geknoeide naam wordt geweigerd', !verifyKey(prefix + '.' + tamperedBody + '.' + sig).valid)

// Handtekening omgooien.
const brokenSig = sig.slice(0, -4) + (sig.endsWith('AAAA') ? 'BBBB' : 'AAAA')
check('aangepaste handtekening wordt geweigerd', !verifyKey(prefix + '.' + body + '.' + brokenSig).valid)

// Een sleutel die met een ánder sleutelpaar is ondertekend: precies wat iemand
// zou proberen die zelf sleutels wil maken.
const stranger = crypto.generateKeyPairSync('ed25519')
const forgedBody = Buffer.from(JSON.stringify({ v: 1, id: 'XXXX-XXXX', n: 'Namaak', iat: '2026-01-01' }))
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')
const forgedSig = crypto
  .sign(null, Buffer.from('FD1.' + forgedBody), stranger.privateKey)
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')
check('sleutel van een vreemd sleutelpaar wordt geweigerd', !verifyKey('FD1.' + forgedBody + '.' + forgedSig).valid)

/* ------------------------------- verlopen -------------------------------- */

const expired = issue(['--verloopt', '2020-01-01'])
const expiredResult = verifyKey(expired)
check('verlopen sleutel wordt geweigerd', !expiredResult.valid)
check('verlooptekst noemt de datum', expiredResult.reason.includes('2020-01-01'), expiredResult.reason)

const future = issue(['--verloopt', '2099-12-31'])
check('sleutel met datum in de toekomst is geldig', verifyKey(future).valid)
check('verloopdatum komt terug', verifyKey(future).info?.expires === '2099-12-31')

console.log('\n' + (fail ? fail + ' mislukt' : 'alles geslaagd'))
process.exit(fail ? 1 : 0)
