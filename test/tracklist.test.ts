import { parseTracklistText, segmentsFromText, splitArtistTitle, parseTime } from '../electron/services/tracklist'
import { applyTemplate, sanitize } from '../electron/services/naming'
import { emptyMeta } from '../shared/types'

let pass = 0
let fail = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass += 1
  } else {
    fail += 1
    console.log('FAIL  ' + name + '\n      verwacht: ' + e + '\n      gekregen: ' + a)
  }
}

/* ------------------------------- tijden ---------------------------------- */

check('parseTime mm:ss', parseTime('3:45'), 225)
check('parseTime h:mm:ss', parseTime('1:02:30'), 3750)
check('parseTime kale seconden', parseTime('90'), 90)
check('parseTime onzin', parseTime('abc'), null)
check('parseTime leeg', parseTime(''), null)

/* --------------------------- artiest en titel ---------------------------- */

check('splitsen op streep', splitArtistTitle('Daft Punk - Around the World'), {
  artist: 'Daft Punk',
  title: 'Around the World'
})
check('ruis uit titel', splitArtistTitle('Daft Punk - Around the World (Official Video)'), {
  artist: 'Daft Punk',
  title: 'Around the World'
})
check('en-streepje telt ook', splitArtistTitle('Artiest – Titel'), { artist: 'Artiest', title: 'Titel' })
check('zonder streep blijft titel', splitArtistTitle('Gewoon een titel'), {
  artist: '',
  title: 'Gewoon een titel'
})

/* ------------------------------ tracklist -------------------------------- */

const desc = [
  'Tracklist:',
  '1. 00:00 Artiest A - Nummer een',
  '2. 04:12 Artiest B - Nummer twee',
  '3. [1:02:30] Artiest C - Nummer drie',
  'Volg mij op instagram'
].join('\n')

check(
  'nummering en haakjes worden gestript',
  parseTracklistText(desc).map((e) => [e.start, e.label]),
  [
    [0, 'Artiest A - Nummer een'],
    [252, 'Artiest B - Nummer twee'],
    [3750, 'Artiest C - Nummer drie']
  ]
)
check(
  'tijd achteraan de regel',
  parseTracklistText('Artiest X - Titel X 12:34').map((e) => [e.start, e.label]),
  [[754, 'Artiest X - Titel X']]
)
check(
  'expliciete van-tot',
  parseTracklistText('00:30 - 02:45 Artiest - Titel').map((e) => [e.start, e.end, e.label]),
  [[30, 165, 'Artiest - Titel']]
)
check('regels zonder tijd tellen niet mee', parseTracklistText('gewoon tekst\nzonder tijden').length, 0)
check('dubbel tijdstip wordt ontdubbeld', parseTracklistText('00:00 A\n00:00 B').length, 1)
check(
  'ongesorteerde invoer komt op volgorde',
  parseTracklistText('05:00 Twee\n01:00 Een').map((e) => e.start),
  [60, 300]
)

const segs = segmentsFromText(desc, { album: 'Set' }, 4000)
check('einde loopt door tot de volgende track', [segs[0].start, segs[0].end], [0, 252])
check('laatste track eindigt op de videoduur', [segs[2].start, segs[2].end], [3750, 4000])
check('artiest afgesplitst', segs[1].meta.artist, 'Artiest B')
check('tracknummers ingevuld', [segs[0].meta.trackNumber, segs[0].meta.totalTracks], ['1', '3'])
check('gemeenschappelijke tag overgenomen', segs[0].meta.album, 'Set')

/* ----------------------------- bestandsnamen ------------------------------ */

check('verboden tekens weg', sanitize('AC/DC: Back? "Black"'), 'AC-DC- Back- -Black-')
check('geen punt aan het eind', sanitize('naam...'), 'naam')
check('gereserveerde naam krijgt prefix', sanitize('CON'), '_CON')
check('accenten naar ascii', sanitize('Beyoncé & Sigur Rós', { ascii: true }), 'Beyonce & Sigur Ros')
check('inkorten op maxlengte', sanitize('a'.repeat(200), { maxLength: 20 }).length, 20)
check('lege invoer', sanitize('   '), 'naamloos')

const meta = { ...emptyMeta(), artist: 'Artiest', title: 'Titel', trackNumber: '3', year: '2024' }
check('sjabloon met tokens', applyTemplate('{track} - {artist} - {title}', meta), '03 - Artiest - Titel')
check('leeg token laat geen streepjes achter', applyTemplate('{album} - {title}', meta), 'Titel')
check('onbekend token wordt leeg', applyTemplate('{title}{zzz}', meta), 'Titel')

console.log('\n' + pass + ' geslaagd, ' + fail + ' mislukt')
process.exit(fail ? 1 : 0)
