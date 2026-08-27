import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import SegmentTable from './SegmentTable'
import { formatDate, formatTime, isProbablyUrl } from '../lib/format'
import { emptyMeta, type ProbeResult, type Segment, type Settings, type TrackMeta } from '../../shared/types'
import type { Toast } from '../App'

interface Props {
  settings: Settings
  notify: (text: string, kind?: Toast['kind']) => void
  goToQueue: () => void
}

type Common = Pick<TrackMeta, 'album' | 'genre' | 'year' | 'label' | 'bpm' | 'initialKey' | 'albumArtist'>

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export default function Download({ settings, notify, goToQueue }: Props): JSX.Element {
  const [url, setUrl] = useState('')
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [common, setCommon] = useState<Common>({
    album: '',
    genre: '',
    year: '',
    label: '',
    bpm: '',
    initialKey: '',
    albumArtist: ''
  })
  const [coverMode, setCoverMode] = useState<'video' | 'file' | 'none'>('video')
  const [coverFile, setCoverFile] = useState('')
  const [squareCover, setSquareCover] = useState(true)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const enabled = useMemo(() => segments.filter((s) => s.enabled), [segments])

  const blocking = useMemo(() => {
    if (!enabled.length) return 'Selecteer minstens één track.'
    for (const s of enabled) {
      if (!s.meta.title.trim()) return 'Elke geselecteerde track heeft een titel nodig.'
      if (s.start !== null && s.end !== null && s.end <= s.start) {
        return `"${s.meta.title || 'naamloos'}": de eindtijd ligt voor of op de starttijd.`
      }
    }
    return ''
  }, [enabled])

  const analyse = async (): Promise<void> => {
    const target = url.trim()
    if (!isProbablyUrl(target)) {
      setError('Plak een volledige link, bijvoorbeeld https://www.youtube.com/watch?v=…')
      return
    }
    setProbing(true)
    setError('')
    try {
      const result = await window.api.source.probe(target)
      setProbe(result)
      setSegments(result.suggestedSegments)
      setCommon((c) => ({
        ...c,
        year: result.uploadDate.slice(0, 4) || c.year,
        albumArtist: result.guess.artist || c.albumArtist,
        album: result.suggestedSegments.length > 1 ? result.title : c.album
      }))
      if (result.suggestionSource === 'chapters') {
        notify(`${result.suggestedSegments.length} tracks overgenomen uit de hoofdstukken.`, 'ok')
      } else if (result.suggestionSource === 'description') {
        notify(
          `${result.suggestedSegments.length} tracks uit de beschrijving gehaald — controleer de tijden even.`,
          'ok'
        )
      }
    } catch (err) {
      setProbe(null)
      setSegments([])
      setError((err as Error).message)
    } finally {
      setProbing(false)
    }
  }

  const baseMeta = (): Partial<TrackMeta> => ({
    artist: probe?.guess.artist ?? '',
    albumArtist: common.albumArtist || probe?.guess.artist || '',
    album: common.album,
    genre: common.genre,
    year: common.year,
    label: common.label
  })

  const useChapters = (): void => {
    if (!probe) return
    window.api.source
      .parseTracklist(
        probe.chapters.map((c) => `${formatTime(c.start)} ${c.title}`).join('\n'),
        baseMeta(),
        probe.duration
      )
      .then(setSegments)
      .catch((err: Error) => setError(err.message))
  }

  const useDescription = (): void => {
    if (!probe) return
    window.api.source
      .parseTracklist(probe.description, baseMeta(), probe.duration)
      .then((segs) => {
        if (!segs.length) {
          notify('Geen tijdstempels gevonden in de beschrijving.', 'err')
          return
        }
        setSegments(segs)
        notify(`${segs.length} tracks gevonden.`, 'ok')
      })
      .catch((err: Error) => setError(err.message))
  }

  const applyPaste = (): void => {
    window.api.source
      .parseTracklist(pasteText, baseMeta(), probe?.duration ?? 0)
      .then((segs) => {
        if (!segs.length) {
          notify('Geen regels met een tijdstempel herkend.', 'err')
          return
        }
        setSegments(segs)
        setPasteOpen(false)
        setPasteText('')
        notify(`${segs.length} tracks ingelezen.`, 'ok')
      })
      .catch((err: Error) => setError(err.message))
  }

  const singleTrack = (): void => {
    if (!probe) return
    setSegments([
      {
        id: newId(),
        enabled: true,
        start: null,
        end: null,
        meta: {
          ...emptyMeta(),
          ...baseMeta(),
          artist: probe.guess.artist,
          title: probe.guess.title
        } as TrackMeta
      }
    ])
  }

  const addRow = (): void => {
    const last = segments[segments.length - 1]
    setSegments([
      ...segments,
      {
        id: newId(),
        enabled: true,
        start: last?.end ?? null,
        end: null,
        meta: { ...emptyMeta(), ...baseMeta(), artist: probe?.guess.artist ?? '' } as TrackMeta
      }
    ])
  }

  const pickCover = async (): Promise<void> => {
    const file = await window.api.dialog.pickImage()
    if (file) {
      setCoverFile(file)
      setCoverMode('file')
    }
  }

  const submit = async (): Promise<void> => {
    if (!probe || blocking) return
    setSubmitting(true)
    try {
      const total = enabled.length
      const prepared = enabled.map((s, i) => ({
        ...s,
        meta: {
          ...s.meta,
          album: common.album || s.meta.album,
          albumArtist: common.albumArtist || s.meta.albumArtist || s.meta.artist,
          genre: common.genre || s.meta.genre,
          year: common.year || s.meta.year,
          label: common.label || s.meta.label,
          bpm: common.bpm || s.meta.bpm,
          initialKey: common.initialKey || s.meta.initialKey,
          trackNumber: total > 1 ? String(i + 1) : s.meta.trackNumber,
          totalTracks: total > 1 ? String(total) : s.meta.totalTracks
        }
      }))

      await window.api.queue.add(
        {
          url: probe.webpageUrl || probe.url,
          sourceTitle: probe.title,
          isLive: probe.isLive,
          segments: prepared,
          coverMode,
          coverUrl: probe.thumbnail,
          coverFile,
          squareCover,
          audio: settings.audio
        },
        probe.duration
      )
      notify(`${total} ${total === 1 ? 'track' : 'tracks'} in de wachtrij gezet.`, 'ok')
      goToQueue()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Downloaden</h1>
        <p>
          Plak een YouTube-link. Bij een dj-set of livestream-opname kun je per track een begin- en eindtijd
          zetten; FlacDeck knipt en levert losse FLAC-bestanden met tags.
        </p>
      </div>

      <div className="card">
        <div className="url-bar">
          <input
            type="text"
            value={url}
            placeholder="https://www.youtube.com/watch?v=…"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void analyse()
            }}
          />
          <button className="btn primary" onClick={() => void analyse()} disabled={probing || !url.trim()}>
            {probing ? <span className="spin" /> : 'Analyseren'}
          </button>
        </div>
        {error && (
          <div className="note err" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </div>

      {probe && (
        <>
          <div className="card">
            <div className="source-card">
              {probe.thumbnail ? (
                <img className="thumb" src={probe.thumbnail} alt="" />
              ) : (
                <div className="thumb" />
              )}
              <div className="source-info" style={{ minWidth: 0 }}>
                <h2>{probe.title}</h2>
                <div className="muted small">{probe.uploader}</div>
                <div className="row row-wrap" style={{ marginTop: 9 }}>
                  <span className="chip">{probe.duration ? formatTime(probe.duration) : 'onbekende duur'}</span>
                  {probe.uploadDate && <span className="chip">{formatDate(probe.uploadDate)}</span>}
                  {probe.isLive && <span className="chip live">● live</span>}
                  {probe.wasLive && <span className="chip">livestream-opname</span>}
                  {probe.chapters.length > 1 && (
                    <span className="chip accent">{probe.chapters.length} hoofdstukken</span>
                  )}
                </div>
              </div>
            </div>

            {probe.isLive && (
              <div className="note warn" style={{ marginTop: 14 }}>
                Deze stream is nog bezig. Knippen op tijd werkt alleen binnen het stuk dat YouTube nog
                terugbewaart (meestal een paar uur). Wacht liever tot de opname na afloop online staat — dan
                kun je exact knippen.
              </div>
            )}
          </div>

          <div className="card">
            <div className="row row-wrap" style={{ marginBottom: 12 }}>
              <div className="card-title" style={{ margin: 0 }}>
                Tracks ({enabled.length} van {segments.length})
              </div>
              <div className="spacer" />
              <button className="btn sm" onClick={singleTrack}>
                Hele video = 1 track
              </button>
              <button className="btn sm" onClick={useChapters} disabled={probe.chapters.length < 2}>
                Uit hoofdstukken
              </button>
              <button className="btn sm" onClick={useDescription}>
                Uit beschrijving
              </button>
              <button className="btn sm" onClick={() => setPasteOpen((v) => !v)}>
                Tracklist plakken
              </button>
              <button className="btn sm" onClick={addRow}>
                + Rij
              </button>
            </div>

            {pasteOpen && (
              <div style={{ marginBottom: 14 }}>
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={'00:00 Artiest - Titel\n04:12 Andere artiest - Andere titel\n1:02:30 Nog een'}
                />
                <div className="row" style={{ marginTop: 8 }}>
                  <span className="faint small">
                    Werkt met tijd vooraan of achteraan, met of zonder nummering.
                  </span>
                  <div className="spacer" />
                  <button className="btn sm" onClick={() => setPasteOpen(false)}>
                    Annuleren
                  </button>
                  <button className="btn primary sm" onClick={applyPaste} disabled={!pasteText.trim()}>
                    Inlezen
                  </button>
                </div>
              </div>
            )}

            {segments.length ? (
              <SegmentTable segments={segments} duration={probe.duration} onChange={setSegments} />
            ) : (
              <div className="empty">Geen tracks. Klik op “Hele video = 1 track” of voeg een rij toe.</div>
            )}

            <div className="note small" style={{ marginTop: 14 }}>
              Leeg laten betekent “vanaf het begin” of “tot het eind”. Tijden mogen als{' '}
              <span className="mono">3:45</span>, <span className="mono">1:02:30</span> of als aantal seconden.
            </div>
          </div>

          <div className="card">
            <div className="card-title">Tags voor alle tracks</div>
            <div className="grid-3">
              <label className="field">
                <span>Album</span>
                <input
                  type="text"
                  value={common.album}
                  onChange={(e) => setCommon({ ...common, album: e.target.value })}
                  placeholder="bijv. naam van de set"
                />
              </label>
              <label className="field">
                <span>Albumartiest</span>
                <input
                  type="text"
                  value={common.albumArtist}
                  onChange={(e) => setCommon({ ...common, albumArtist: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Genre</span>
                <input
                  type="text"
                  value={common.genre}
                  onChange={(e) => setCommon({ ...common, genre: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Jaar</span>
                <input
                  type="text"
                  value={common.year}
                  onChange={(e) => setCommon({ ...common, year: e.target.value })}
                  placeholder="2024"
                />
              </label>
              <label className="field">
                <span>Label</span>
                <input
                  type="text"
                  value={common.label}
                  onChange={(e) => setCommon({ ...common, label: e.target.value })}
                />
              </label>
              <label className="field">
                <span>BPM (optioneel)</span>
                <input
                  type="text"
                  value={common.bpm}
                  onChange={(e) => setCommon({ ...common, bpm: e.target.value })}
                  placeholder="laat leeg, rekordbox rekent zelf"
                />
              </label>
            </div>
          </div>

          <div className="card">
            <div className="card-title">Hoesafbeelding</div>
            <div className="row row-wrap">
              <label className="checkbox">
                <input
                  type="radio"
                  name="cover"
                  checked={coverMode === 'video'}
                  onChange={() => setCoverMode('video')}
                />
                Videominiatuur
              </label>
              <label className="checkbox">
                <input
                  type="radio"
                  name="cover"
                  checked={coverMode === 'file'}
                  onChange={() => void pickCover()}
                />
                Eigen afbeelding
              </label>
              <label className="checkbox">
                <input
                  type="radio"
                  name="cover"
                  checked={coverMode === 'none'}
                  onChange={() => setCoverMode('none')}
                />
                Geen
              </label>
              <div className="spacer" />
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={squareCover}
                  onChange={(e) => setSquareCover(e.target.checked)}
                  disabled={coverMode === 'none'}
                />
                Vierkant bijsnijden (800×800)
              </label>
            </div>
            {coverMode === 'file' && coverFile && (
              <div className="faint small mono" style={{ marginTop: 8 }}>
                {coverFile}
              </div>
            )}
          </div>

          <div className="row" style={{ marginBottom: 40 }}>
            {blocking && <span className="small" style={{ color: 'var(--err)' }}>{blocking}</span>}
            <div className="spacer" />
            <button
              className="btn primary"
              onClick={() => void submit()}
              disabled={Boolean(blocking) || submitting}
            >
              {submitting ? 'Bezig…' : `In wachtrij zetten (${enabled.length})`}
            </button>
          </div>
        </>
      )}
    </>
  )
}
