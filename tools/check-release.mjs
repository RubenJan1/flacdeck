#!/usr/bin/env node
/**
 * Controleert of alles klaarstaat om een versie uit te brengen.
 * Een verkeerde owner of repo breekt het automatisch bijwerken stil, dus
 * beter hier gevonden dan door een gebruiker die geen updates krijgt.
 *
 *   npm run check:release
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problemen = []
const opmerkingen = []

function lees(bestand) {
  return fs.readFileSync(path.join(root, bestand), 'utf8')
}

/* ------------------------- owner en repo vergelijken ---------------------- */

const builder = lees('electron-builder.yml')
const owner = builder.match(/^\s*owner:\s*(\S+)/m)?.[1]
const repo = builder.match(/^\s*repo:\s*(\S+)/m)?.[1]

if (!owner || !repo) {
  problemen.push('electron-builder.yml mist publish.owner of publish.repo.')
}

const pkg = JSON.parse(lees('package.json'))
const url = pkg.repository?.url ?? ''
const uitPkg = url.match(/github\.com\/([^/]+)\/([^/.]+)/)

if (!uitPkg) {
  problemen.push('package.json mist een repository-url die naar GitHub wijst.')
} else if (owner && repo && (uitPkg[1] !== owner || uitPkg[2] !== repo)) {
  problemen.push(
    'package.json wijst naar ' + uitPkg[1] + '/' + uitPkg[2] +
      ' maar electron-builder.yml naar ' + owner + '/' + repo + '. Die moeten gelijk zijn.'
  )
}

/* ----------------------------- git-afstand -------------------------------- */

// stdio: git's eigen foutmeldingen onderdrukken; wij melden het zelf netter.
const stil = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }

let remote = ''
try {
  remote = execFileSync('git', ['remote', 'get-url', 'origin'], stil).trim()
} catch {
  problemen.push('Nog geen git-remote. Draai:  git remote add origin https://github.com/' + (owner ?? 'jij') + '/' + (repo ?? 'flacdeck') + '.git')
}

if (remote) {
  const uitRemote = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
  if (!uitRemote) problemen.push('De remote wijst niet naar GitHub: ' + remote)
  else if (owner && repo && (uitRemote[1] !== owner || uitRemote[2] !== repo)) {
    problemen.push(
      'De remote is ' + uitRemote[1] + '/' + uitRemote[2] +
        ' maar de instellingen zeggen ' + owner + '/' + repo + '.'
    )
  }
}

/* ------------------------------- geheimen --------------------------------- */

// De geheime sleutel mag nooit in git terechtkomen.
try {
  const gevolgd = execFileSync('git', ['ls-files', 'keys'], stil).trim()
  if (gevolgd) problemen.push('LET OP: keys/ wordt door git gevolgd. Haal het eruit:  git rm -r --cached keys')
} catch {
  /* geen repo; daar is hierboven al over geklaagd */
}

if (!fs.existsSync(path.join(root, 'keys', 'private.pem'))) {
  opmerkingen.push('Geen keys/private.pem — je kunt geen sleutels uitgeven. Draai:  npm run licence:init')
}

if (!fs.existsSync(path.join(root, 'shared', 'licence-key.ts'))) {
  problemen.push('shared/licence-key.ts ontbreekt; zonder publieke sleutel kan de app niets controleren.')
}

/* ----------------------------- werkmap schoon ----------------------------- */

try {
  const vuil = execFileSync('git', ['status', '--porcelain'], stil).trim()
  if (vuil) opmerkingen.push('Er zijn nog niet-vastgelegde wijzigingen; leg die eerst vast voor je een tag zet.')
} catch {
  /* al gemeld */
}

/* -------------------------------- uitvoer --------------------------------- */

console.log('')
if (owner && repo) console.log('  Publiceert naar: github.com/' + owner + '/' + repo)
console.log('  Versie in package.json: ' + pkg.version)
console.log('')

for (const o of opmerkingen) console.log('  let op   ' + o)
for (const p of problemen) console.log('  FOUT     ' + p)

if (!problemen.length) {
  console.log('  Alles staat klaar. Uitbrengen doe je zo:')
  console.log('')
  console.log('    npm version patch')
  console.log('    git push --follow-tags')
  console.log('')
  process.exit(0)
}

console.log('')
process.exit(1)
