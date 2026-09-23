import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import SegmentTable from './SegmentTable'
import { formatBytes, formatTime, isProbablyUrl } from '../lib/format'
import {
  emptyMeta,
  type DriveCheck,
  type DriveInfo,
  type ExportLayout,
  type ExportResult,
  type Job,
  type LibraryItem,
  type ProbeResult,
  type Segment,
  type Settings,
  type TrackMeta
} from '../../shared/types'
import type { Toast } from '../App'

interface Props {
  settings: Settings
  jobs: Job[]
  notify: (text: string, kind?: Toast['kind']) => void
  onSettings: (patch: Partial<Settings>) => void
  onAdvanced: () => void
}

type Step = 'start' | 'tracks' | 'werken' | 'stick' | 'klaar'

const STEPS: { id: Step; label: string }[] = [
  { id: 'start', label: 'Link' },
  { id: 'tracks', label: 'Nummers' },
  { id: 'werken', label: 'Ophalen' },
  { id: 'stick', label: 'Stick' },
  { id: 'klaar', label: 'Klaar' }
]

/** Drie soorten apparaten in plaats van vier technische mapindelingen. */
const SPELERS: { id: ExportLayout; titel: string; uitleg: string; icoon: string }[] = [
  { id: 'car', titel: 'Auto of geluidsinstallatie', uitleg: 'Gewone USB-speler', icoon: '🚗' },
  { id: 'dj', titel: 'DJ-speler', uitleg: 'Pioneer, Denon, rekordbox', icoon: '🎛' },
  { id: 'flat', titel: 'Computer', uitleg: 'Alles los in één map', icoon: '💻' }
]

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export default function Simple({ settings, jobs, notify, onSettings, onAdvanced }: Props): JSX.Element {
  const [step, setStep] = useState<Step>('start')

  // Stap 1 en 2
  const [url, setUrl] = useState('')
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [fout, setFout] = useState('')

  // Stap 3
  const [batchIds, setBatchIds] = useState<string[]>([])

  // Stap 4
  const [library, setLibrary] = useState<LibraryItem[]>([])
  const [alles, setAlles] = useState(false)
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [target, setTarget] = useState('')
  const [check, setCheck] = useState<DriveCheck | null>(null)
  const [layout, setLayout] = useState<ExportLayout>(
    settings.usb.layout === 'library' ? 'car' : settings.usb.layout
  )
  const [kopieren, setKopieren] = useState(false)
  const [voortgang, setVoortgang] = useState({ done: 0, total: 0, current: '' })
  const [resultaat, setResultaat] = useState<ExportResult | null>(null)

  // Stap 5
  const [uitwerpen, setUitwerpen] = useState(false)
  const [losgekoppeld, setLosgekoppeld] = useState<{ ok: boolean; message: string } | null>(null)

  const mijnJobs = useMemo(() => jobs.filter((j) => batchIds.includes(j.id)), [jobs, batchIds])
  const klaarJobs = useMemo(() => mijnJobs.filter((j) => j.status === 'klaar'), [mijnJobs])
  const busyJobs = useMemo(
    () => mijnJobs.filter((j) => !['klaar', 'fout', 'geannuleerd'].includes(j.status)),
    [mijnJobs]
  )
  const stukJobs = useMemo(() => mijnJobs.filter((j) => j.status === 'fout'), [mijnJobs])

  /* ------------------------------ stap 1 --------------------------------- */

  const zoek = async (): Promise<void> => {
    const link = url.trim()
    if (!isProbablyUrl(link)) {
      setFout('Dat lijkt geen link. Kopieer de hele regel uit de adresbalk van YouTube, die begint met https://')
      return
    }
    setProbing(true)
    setFout('')
    try {
      const gevonden = await window.api.source.probe(link)
      setProbe(gevonden)
      setSegments(
        gevonden.suggestedSegments.length
          ? gevonden.suggestedSegments
          : [
              {
                id: newId(),
                enabled: true,
                start: null,
                end: null,
                meta: {
                  ...emptyMeta(),
                  artist: gevonden.guess.artist,
                  title: gevonden.guess.title
                } as TrackMeta
              }
            ]
      )
      setStep('tracks')
    } catch (err) {
      setProbe(null)
      setFout((err as Error).message)
    } finally {
      setProbing(false)
    }
  }

  /* ------------------------------ stap 2 --------------------------------- */

  const heleVideo = (): void => {
    if (!probe) return
    setSegments([
      {
        id: newId(),
        enabled: true,
        start: null,
        end: null,
        meta: { ...emptyMeta(), artist: probe.guess.artist, title: probe.guess.title } as TrackMeta
      }
    ])
  }

  const aangevinkt = useMemo(() => segments.filter((s) => s.enabled), [segments])

  const haalOp = async (): Promise<void> => {
    if (!probe) return
    const leeg = aangevinkt.find((s) => !s.meta.title.trim())
    if (leeg) {
      setFout('Eén van de nummers heeft nog geen titel. Vul die eerst in.')
      return
    }
    setFout('')
    try {
      const totaal = aangevinkt.length
      const ids = await window.api.queue.add(
        {
          url: probe.webpageUrl || probe.url,
          sourceTitle: probe.title,
          isLive: probe.isLive,
          segments: aangevinkt.map((s, i) => ({
            ...s,
            meta: {
              ...s.meta,
              album: s.meta.album || (totaal > 1 ? probe.title : ''),
              albumArtist: s.meta.albumArtist || s.meta.artist,
              trackNumber: totaal > 1 ? String(i + 1) : s.meta.trackNumber,
              totalTracks: totaal > 1 ? String(totaal) : s.meta.totalTracks
            }
          })),
          coverMode: 'video',
          coverUrl: probe.thumbnail,
          coverFile: '',
          squareCover: true,
          audio: settings.audio
        },
        probe.duration
      )
      setBatchIds(ids)
      setStep('werken')
    } catch (err) {
      setFout((err as Error).message)
    }
  }

  /* ------------------------------ stap 4 --------------------------------- */

  const zoekSticks = useCallback(async () => {
    const gevonden = await window.api.usb.drives()
    setDrives(gevonden)
    setTarget((huidig) => {
      if (huidig && gevonden.some((d) => d.path === huidig)) return huidig
      return gevonden.find((d) => d.removable)?.path ?? ''
    })
  }, [])

  const laadBibliotheek = useCallback(async () => {
    setLibrary(await window.api.library.scan())
  }, [])

  useEffect(() => {
    if (step !== 'stick') return
    void zoekSticks()
    void laadBibliotheek()
    const stop = window.api.usb.onProgress(setVoortgang)
    // Een stick die er tussendoor in wordt gestoken moet vanzelf verschijnen;
    // niemand hoort te moeten weten dat er een verversknop bestaat. Tijdens het
    // kopiëren ligt dat stil: de schijf heeft het dan al druk genoeg.
    const timer = setInterval(() => {
      if (!kopieren) void zoekSticks()
    }, 3000)
    return () => {
      stop()
      clearInterval(timer)
    }
  }, [step, zoekSticks, laadBibliotheek, kopieren])

  useEffect(() => {
    if (step !== 'stick' || !target) {
      setCheck(null)
      return
    }
    let actueel = true
    void window.api.usb.check(target, layout).then((c) => {
      if (actueel) setCheck(c)
    })
    return () => {
      actueel = false
    }
  }, [step, target, layout])

  const nieuwePaden = useMemo(
    () => klaarJobs.map((j) => j.outputPath).filter((p): p is string => Boolean(p)),
    [klaarJobs]
  )
  const tePaden = alles || !nieuwePaden.length ? library.map((i) => i.path) : nieuwePaden
  const teBytes = useMemo(() => {
    const perPad = new Map(library.map((i) => [i.path, i.size]))
    return tePaden.reduce((som, p) => som + (perPad.get(p) ?? 0), 0)
  }, [library, tePaden])

  const drive = drives.find((d) => d.path === target)
  const past = !drive || drive.freeBytes <= 0 || teBytes <= drive.freeBytes

  const kopieer = async (): Promise<void> => {
    if (!target || !tePaden.length || check?.level === 'block') return
    setKopieren(true)
    setResultaat(null)
    setLosgekoppeld(null)
    setVoortgang({ done: 0, total: tePaden.length, current: '' })
    void window.api.app.setBusy('FlacDeck is muziek naar de stick aan het kopiëren.')
    try {
      const res = await window.api.usb.exportTracks({
        paths: tePaden,
        target,
        layout,
        asciiNames: false,
        createM3u: true,
        playlistName: 'FlacDeck',
        overwrite: false
      })
      setResultaat(res)
      onSettings({ usb: { ...settings.usb, layout } })
      setStep('klaar')
    } catch (err) {
      notify((err as Error).message, 'err')
    } finally {
      void window.api.app.setBusy('')
      setKopieren(false)
    }
  }

  /* ------------------------------ stap 5 --------------------------------- */

  const werpUit = async (): Promise<void> => {
    setUitwerpen(true)
    try {
      setLosgekoppeld(await window.api.usb.eject(target))
    } catch (err) {
      setLosgekoppeld({ ok: false, message: (err as Error).message })
    } finally {
      setUitwerpen(false)
    }
  }

  const opnieuw = (): void => {
    setUrl('')
    setProbe(null)
    setSegments([])
    setBatchIds([])
    setResultaat(null)
    setLosgekoppeld(null)
    setAlles(false)
    setFout('')
    setStep('start')
  }

  /* ------------------------------- beeld --------------------------------- */

  const stapNr = STEPS.findIndex((s) => s.id === step) + 1

  return (
    <div className="wiz">
      <div className="wiz-top">
        <ol className="wiz-steps">
          {STEPS.map((s, i) => (
            <li
              key={s.id}
              className={'wiz-dot' + (i + 1 === stapNr ? ' nu' : '') + (i + 1 < stapNr ? ' gedaan' : '')}
            >
              <span className="wiz-dot-nr">{i + 1 < stapNr ? '✓' : i + 1}</span>
              <span>{s.label}</span>
            </li>
          ))}
        </ol>
        <button className="btn ghost sm" onClick={onAdvanced}>
          Geavanceerd
        </button>
      </div>

      {/* --------------------------- stap 1 ----------------------------- */}
      {step === 'start' && (
        <div className="wiz-card">
          <h1>Welke muziek wil je hebben?</h1>
          <p className="wiz-lead">
            Ga in je browser naar het filmpje op YouTube, kopieer de hele regel uit de adresbalk en plak hem
            hieronder.
          </p>
          <input
            type="text"
            className="wiz-input"
            value={url}
            placeholder="https://www.youtube.com/watch?v=..."
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void zoek()
            }}
          />
          {fout && <div className="note err wiz-note">{fout}</div>}
          <button className="btn primary wiz-big" onClick={() => void zoek()} disabled={probing || !url.trim()}>
            {probing ? <span className="spin" /> : 'Zoek deze muziek op'}
          </button>
          <button
            className="btn ghost wiz-link"
            onClick={() => {
              setFout('')
              setStep('stick')
            }}
          >
            Ik heb de muziek al — ik wil alleen een USB-stick vullen
          </button>
        </div>
      )}

      {/* --------------------------- stap 2 ----------------------------- */}
      {step === 'tracks' && probe && (
        <div className="wiz-card breed">
          <h1>Klopt deze lijst?</h1>
          <div className="source-card" style={{ marginBottom: 18 }}>
            {probe.thumbnail ? <img className="thumb" src={probe.thumbnail} alt="" /> : <div className="thumb" />}
            <div className="source-info" style={{ minWidth: 0 }}>
              <h2>{probe.title}</h2>
              <div className="muted small">
                {probe.uploader} · {probe.duration ? formatTime(probe.duration) : 'onbekende duur'}
              </div>
            </div>
          </div>

          <p className="wiz-lead">
            {segments.length > 1
              ? 'FlacDeck heeft ' +
                segments.length +
                ' losse nummers in dit filmpje gevonden. Haal het vinkje weg bij wat je niet wilt, en verbeter de tijden als er iets niet klopt.'
              : 'Dit wordt één nummer. Wil je er losse nummers uit knippen, vul dan per regel in wanneer het begint en stopt.'}
          </p>

          <div className="row row-wrap" style={{ marginBottom: 10 }}>
            <button className="btn sm" onClick={heleVideo}>
              Het is één nummer
            </button>
            <button
              className="btn sm"
              onClick={() =>
                setSegments([
                  ...segments,
                  {
                    id: newId(),
                    enabled: true,
                    start: segments[segments.length - 1]?.end ?? null,
                    end: null,
                    meta: { ...emptyMeta(), artist: probe.guess.artist } as TrackMeta
                  }
                ])
              }
            >
              + Nummer erbij
            </button>
          </div>

          <SegmentTable segments={segments} duration={probe.duration} onChange={setSegments} />

          {fout && <div className="note err wiz-note">{fout}</div>}

          <div className="wiz-foot">
            <button className="btn" onClick={() => setStep('start')}>
              Terug
            </button>
            <button className="btn primary wiz-big" onClick={() => void haalOp()} disabled={!aangevinkt.length}>
              Haal {aangevinkt.length} {aangevinkt.length === 1 ? 'nummer' : 'nummers'} op
            </button>
          </div>
        </div>
      )}

      {/* --------------------------- stap 3 ----------------------------- */}
      {step === 'werken' && (
        <div className="wiz-card">
          <h1>{busyJobs.length ? 'Even geduld…' : 'De muziek staat klaar'}</h1>
          <p className="wiz-lead">
            {busyJobs.length
              ? 'FlacDeck haalt de muziek op en zet hem om. Laat dit venster openstaan.'
              : klaarJobs.length + ' van de ' + mijnJobs.length + ' nummers zijn gelukt.'}
          </p>

          <div className="wiz-teller">
            {klaarJobs.length} / {mijnJobs.length}
          </div>
          <div className="bar groot">
            <i style={{ width: (mijnJobs.length ? (klaarJobs.length / mijnJobs.length) * 100 : 0) + '%' }} />
          </div>

          <ul className="wiz-lijst">
            {mijnJobs.map((j) => (
              <li key={j.id}>
                <span className={'wiz-status ' + j.status}>
                  {j.status === 'klaar' ? '✓' : j.status === 'fout' ? '✕' : '…'}
                </span>
                <span className="wiz-naam">{j.meta.title || j.sourceTitle}</span>
                <span className="faint small">{j.status === 'fout' ? j.error : j.stage}</span>
              </li>
            ))}
          </ul>

          {stukJobs.length > 0 && !busyJobs.length && (
            <div className="note warn wiz-note">
              {stukJobs.length} {stukJobs.length === 1 ? 'nummer is' : 'nummers zijn'} niet gelukt. Meestal helpt
              het om het gewoon nog een keer te proberen.
              <button
                className="btn sm"
                style={{ marginLeft: 10 }}
                onClick={() => stukJobs.forEach((j) => void window.api.queue.retry(j.id))}
              >
                Probeer opnieuw
              </button>
            </div>
          )}

          <div className="wiz-foot">
            <button className="btn" onClick={opnieuw}>
              Nog een filmpje
            </button>
            <button
              className="btn primary wiz-big"
              onClick={() => setStep('stick')}
              disabled={Boolean(busyJobs.length) || !klaarJobs.length}
            >
              Verder naar de USB-stick
            </button>
          </div>
        </div>
      )}

      {/* --------------------------- stap 4 ----------------------------- */}
      {step === 'stick' && (
        <div className="wiz-card">
          <h1>Steek de USB-stick in de computer</h1>

          <div className="wiz-vraag">Waar ga je de stick in doen?</div>
          <div className="speler-rij">
            {SPELERS.map((s) => (
              <button
                key={s.id}
                className={'speler' + (layout === s.id ? ' gekozen' : '')}
                onClick={() => setLayout(s.id)}
              >
                <span className="speler-icoon">{s.icoon}</span>
                <span className="speler-titel">{s.titel}</span>
                <span className="speler-uitleg">{s.uitleg}</span>
              </button>
            ))}
          </div>

          <div className="wiz-vraag">Welke stick?</div>
          {drives.length ? (
            drives.map((d) => (
              <button
                key={d.path}
                className={'drive groot' + (target === d.path ? ' selected' : '')}
                onClick={() => setTarget(d.path)}
              >
                <span style={{ fontSize: 22 }}>{d.removable ? '🔌' : '💽'}</span>
                <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <span className="job-title">{d.label}</span>
                  <span className="job-sub">
                    {formatBytes(d.freeBytes)} vrij van {formatBytes(d.totalBytes)}
                    {d.removable ? '' : ' · dit is geen losse stick'}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <div className="note wiz-note">
              Nog geen stick gevonden. Steek hem in een USB-poort; hij verschijnt vanzelf.
            </div>
          )}

          {check && check.level !== 'ok' && (
            <div className={'note ' + (check.level === 'block' ? 'err' : 'warn') + ' wiz-note'}>
              <strong>{check.title}</strong>
              <div style={{ marginTop: 4 }}>{check.message}</div>
              {check.fix && <div style={{ marginTop: 8 }}>{check.fix}</div>}
            </div>
          )}

          <div className="wiz-vraag">Wat gaat er op?</div>
          <div className="row row-wrap">
            <label className="checkbox groot">
              <input
                type="radio"
                name="welke"
                checked={!alles && nieuwePaden.length > 0}
                disabled={!nieuwePaden.length}
                onChange={() => setAlles(false)}
              />
              De {nieuwePaden.length} nummers die je net hebt opgehaald
            </label>
            <label className="checkbox groot">
              <input
                type="radio"
                name="welke"
                checked={alles || !nieuwePaden.length}
                onChange={() => setAlles(true)}
              />
              Alle {library.length} nummers in FlacDeck
            </label>
          </div>

          <div className="wiz-samenvatting">
            {tePaden.length} {tePaden.length === 1 ? 'nummer' : 'nummers'} · {formatBytes(teBytes)}
          </div>

          {!past && (
            <div className="note err wiz-note">
              Dit past niet op de stick. Er is {formatBytes(drive?.freeBytes ?? 0)} vrij en je wilt{' '}
              {formatBytes(teBytes)} kopiëren.
            </div>
          )}

          {kopieren && (
            <>
              <div className="bar groot">
                <i style={{ width: (voortgang.total ? (voortgang.done / voortgang.total) * 100 : 0) + '%' }} />
              </div>
              <div className="wiz-teller klein">
                {voortgang.done} / {voortgang.total}
              </div>
              <div className="note warn wiz-note">
                Bezig met kopiëren. Haal de stick er nu niet uit en sluit FlacDeck niet af.
              </div>
            </>
          )}

          <div className="wiz-foot">
            <button className="btn" onClick={() => setStep(batchIds.length ? 'werken' : 'start')} disabled={kopieren}>
              Terug
            </button>
            <button
              className="btn primary wiz-big"
              onClick={() => void kopieer()}
              disabled={kopieren || !target || !tePaden.length || !past || check?.level === 'block'}
            >
              {kopieren ? 'Bezig met kopiëren…' : 'Kopieer naar de stick'}
            </button>
          </div>
        </div>
      )}

      {/* --------------------------- stap 5 ----------------------------- */}
      {step === 'klaar' && resultaat && (
        <div className="wiz-card">
          {losgekoppeld?.ok ? (
            <>
              <div className="wiz-groot-vink">✓</div>
              <h1>Je mag de stick er nu uithalen</h1>
              <p className="wiz-lead">
                Er staan {resultaat.verified} {resultaat.verified === 1 ? 'nummer' : 'nummers'} op. De computer is
                klaar met schrijven en heeft de stick losgelaten.
              </p>
            </>
          ) : (
            <>
              <h1>Nog één stap: de stick loskoppelen</h1>
              <p className="wiz-lead">
                {resultaat.verified} {resultaat.verified === 1 ? 'nummer staat' : 'nummers staan'} op de stick
                {resultaat.skipped ? ' (' + resultaat.skipped + ' stond er al)' : ''}.
                <strong> Trek de stick er nog niet uit.</strong> De computer moet hem eerst netjes loslaten,
                anders raakt de stick beschadigd en speelt hij straks maar een paar nummers.
              </p>
            </>
          )}

          {resultaat.missing.length > 0 && (
            <div className="note err wiz-note">
              {resultaat.missing.length} {resultaat.missing.length === 1 ? 'nummer is' : 'nummers zijn'} niet goed
              overgekomen. Kopieer ze opnieuw voordat je de stick meeneemt.
            </div>
          )}
          {resultaat.failed.map((f) => (
            <div key={f.path} className="note err wiz-note small">
              {f.path.split(/[\\/]/).pop()}: {f.error}
            </div>
          ))}
          {resultaat.warnings.map((w) => (
            <div key={w} className="note warn wiz-note">
              {w}
            </div>
          ))}

          {losgekoppeld && !losgekoppeld.ok && <div className="note err wiz-note">{losgekoppeld.message}</div>}

          <div className="wiz-foot">
            <button className="btn" onClick={opnieuw}>
              Begin opnieuw
            </button>
            {!losgekoppeld?.ok && (
              <button className="btn primary wiz-big" onClick={() => void werpUit()} disabled={uitwerpen}>
                {uitwerpen ? 'Bezig…' : 'Koppel de stick los'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
