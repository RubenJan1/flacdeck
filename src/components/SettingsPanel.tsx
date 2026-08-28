import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { AudioSettings, BinaryStatus, LicenceStatus, Settings } from '../../shared/types'
import type { Toast } from '../App'

interface Props {
  settings: Settings
  binaries: BinaryStatus | null
  licence: LicenceStatus
  onChange: (patch: Partial<Settings>) => Promise<void>
  onBinariesChanged: () => Promise<void>
  onLicenceChanged: (status: LicenceStatus) => void
  notify: (text: string, kind?: Toast['kind']) => void
}

const BROWSERS = ['', 'chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'safari']

export default function SettingsPanel({
  settings,
  binaries,
  licence,
  onChange,
  onBinariesChanged,
  onLicenceChanged,
  notify
}: Props): JSX.Element {
  const [updating, setUpdating] = useState(false)
  const [checking, setChecking] = useState(false)
  const [pct, setPct] = useState(0)
  const [naming, setNaming] = useState(settings.naming)

  useEffect(() => window.api.binaries.onProgress(setPct), [])
  useEffect(() => setNaming(settings.naming), [settings.naming])

  const audio = (patch: Partial<AudioSettings>): void => {
    void onChange({ audio: { ...settings.audio, ...patch } })
  }

  const pickOutput = async (): Promise<void> => {
    const dir = await window.api.dialog.pickDirectory('Waar moeten de FLAC-bestanden komen?')
    if (dir) await onChange({ outputDir: dir })
  }

  const updateYtdlp = async (): Promise<void> => {
    setUpdating(true)
    setPct(0)
    try {
      await window.api.binaries.installYtdlp()
      await onBinariesChanged()
      notify('yt-dlp bijgewerkt.', 'ok')
    } catch (err) {
      notify('Bijwerken mislukt: ' + (err as Error).message, 'err')
    } finally {
      setUpdating(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Instellingen</h1>
      </div>

      <div className="card">
        <div className="card-title">Opslag</div>
        <label className="field">
          <span>Map voor nieuwe FLAC-bestanden</span>
          <div className="row">
            <input type="text" value={settings.outputDir} readOnly className="mono small" />
            <button className="btn" onClick={() => void pickOutput()}>
              Wijzigen…
            </button>
            <button className="btn ghost" onClick={() => void window.api.shell.openPath(settings.outputDir)}>
              Openen
            </button>
          </div>
        </label>

        <label className="field">
          <span>Bestandsnaam</span>
          <div className="row">
            <input
              type="text"
              value={naming}
              className="mono"
              onChange={(e) => setNaming(e.target.value)}
              onBlur={() => void onChange({ naming: naming.trim() || '{artist} - {title}' })}
            />
          </div>
          <span className="faint small" style={{ display: 'block', marginTop: 6 }}>
            Beschikbaar: {'{artist} {title} {album} {albumartist} {track} {year} {genre} {bpm} {key} {label}'}
          </span>
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.keepSource}
            onChange={(e) => void onChange({ keepSource: e.target.checked })}
          />
          Gedownloade bronbestanden bewaren (handig om opnieuw te knippen, kost schijfruimte)
        </label>
      </div>

      <div className="card">
        <div className="card-title">Audio</div>
        <div className="note small" style={{ marginBottom: 14 }}>
          YouTube levert altijd gecomprimeerde audio (Opus of AAC). FLAC bewaart dát signaal verliesvrij, maar
          maakt er geen cd-kwaliteit van. Voor een dj-set uit een stream is dit prima; verwacht geen master.
        </div>

        <div className="grid-3">
          <label className="field">
            <span>FLAC-compressie ({settings.audio.compression})</span>
            <input
              type="range"
              min={0}
              max={12}
              value={settings.audio.compression}
              onChange={(e) => audio({ compression: Number(e.target.value) })}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
            />
          </label>

          <label className="field">
            <span>Samplerate</span>
            <select
              value={settings.audio.sampleRate}
              onChange={(e) => audio({ sampleRate: e.target.value as AudioSettings['sampleRate'] })}
            >
              <option value="source">Zoals de bron</option>
              <option value="44100">44,1 kHz (cd / dj-standaard)</option>
              <option value="48000">48 kHz</option>
            </select>
          </label>

          <label className="field">
            <span>Bitdiepte</span>
            <select
              value={settings.audio.bitDepth}
              onChange={(e) => audio({ bitDepth: e.target.value as AudioSettings['bitDepth'] })}
            >
              <option value="source">Zoals de bron</option>
              <option value="16">16-bit</option>
              <option value="24">24-bit</option>
            </select>
          </label>

          <label className="field">
            <span>Fade-in (sec)</span>
            <input
              type="number"
              min={0}
              max={10}
              step={0.5}
              value={settings.audio.fadeIn}
              onChange={(e) => audio({ fadeIn: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span>Fade-out (sec)</span>
            <input
              type="number"
              min={0}
              max={10}
              step={0.5}
              value={settings.audio.fadeOut}
              onChange={(e) => audio({ fadeOut: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span>Gelijktijdige taken</span>
            <input
              type="number"
              min={1}
              max={6}
              value={settings.concurrency}
              onChange={(e) => void onChange({ concurrency: Number(e.target.value) })}
            />
          </label>
        </div>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.audio.normalize}
            onChange={(e) => audio({ normalize: e.target.checked })}
          />
          Volume gelijktrekken naar {settings.audio.targetLufs} LUFS
        </label>
        <div className="faint small" style={{ marginTop: 6 }}>
          Laat dit uit voor dj-gebruik: rekordbox en Engine regelen gain zelf, en normaliseren kost dynamiek.
        </div>
      </div>

      <div className="card">
        <div className="card-title">Netwerk en toegang</div>
        <div className="grid-2">
          <label className="field">
            <span>Cookies uit browser</span>
            <select
              value={settings.cookiesFromBrowser}
              onChange={(e) => void onChange({ cookiesFromBrowser: e.target.value })}
            >
              {BROWSERS.map((b) => (
                <option key={b} value={b}>
                  {b === '' ? 'Uit' : b}
                </option>
              ))}
            </select>
            <span className="faint small" style={{ display: 'block', marginTop: 6 }}>
              Nodig voor video&apos;s met leeftijdscheck of ledencontent. De browser moet dicht zijn.
            </span>
          </label>

          <label className="field">
            <span>Proxy (optioneel)</span>
            <input
              type="text"
              className="mono small"
              value={settings.proxy}
              placeholder="http://host:poort"
              onChange={(e) => void onChange({ proxy: e.target.value })}
            />
          </label>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Onderdelen</div>
        {binaries && (
          <div className="small mono muted" style={{ lineHeight: 1.9 }}>
            <div>ffmpeg: {binaries.ffmpeg.ok ? binaries.ffmpeg.version : 'NIET GEVONDEN'}</div>
            <div>ffprobe: {binaries.ffprobe.ok ? binaries.ffprobe.version : 'NIET GEVONDEN'}</div>
            <div>yt-dlp: {binaries.ytdlp.ok ? binaries.ytdlp.version : 'NIET GEVONDEN'}</div>
            <div>{binaries.ytdlp.path}</div>
          </div>
        )}
        {binaries && !binaries.ytdlp.ok && binaries.ytdlp.error && (
          <div className="note err" style={{ marginTop: 10 }}>
            {binaries.ytdlp.error}
          </div>
        )}
        {updating && (
          <div className="bar" style={{ margin: '12px 0' }}>
            <i style={{ width: pct + '%' }} />
          </div>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void updateYtdlp()} disabled={updating}>
            {updating ? 'Bezig… ' + pct + '%' : 'yt-dlp bijwerken'}
          </button>
          <span className="faint small">
            Doe dit als downloads plotseling falen — YouTube verandert regelmatig iets.
          </span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Versie</div>
        <div className="row row-wrap">
          <button
            className="btn"
            disabled={checking}
            onClick={() => {
              setChecking(true)
              void window.api.update
                .check()
                .then((s) => {
                  if (s.state === 'actueel') notify('Je hebt de nieuwste versie.', 'ok')
                  else if (s.state === 'beschikbaar') notify('Versie ' + s.version + ' is beschikbaar.', 'ok')
                  else if (s.state === 'uit') notify('Bijwerken werkt alleen in de geïnstalleerde app.', 'info')
                  else if (s.state === 'fout') notify('Zoeken mislukt: ' + s.error, 'err')
                })
                .finally(() => setChecking(false))
            }}
          >
            {checking ? 'Zoeken…' : 'Zoeken naar updates'}
          </button>
          <span className="faint small">
            FlacDeck kijkt bij het starten zelf of er een nieuwe versie is.
          </span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Toegangssleutel</div>
        {licence.info ? (
          <div className="small muted" style={{ lineHeight: 1.9 }}>
            <div>
              Op naam van <strong style={{ color: 'var(--text)' }}>{licence.info.name}</strong>
              {licence.info.email ? ' · ' + licence.info.email : ''}
            </div>
            <div className="mono">
              sleutel {licence.info.id} · uitgegeven {licence.info.issued || 'onbekend'} · geldig tot{' '}
              {licence.info.expires || 'onbeperkt'}
            </div>
          </div>
        ) : (
          <div className="muted small">Geen sleutelgegevens beschikbaar.</div>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn danger"
            onClick={() => {
              void window.api.licence.deactivate().then((status) => {
                onLicenceChanged(status)
                notify('Sleutel van deze computer verwijderd.', 'ok')
              })
            }}
          >
            Sleutel verwijderen van deze computer
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 40 }}>
        <div className="card-title">Herstellen</div>
        <button
          className="btn danger"
          onClick={() => {
            void window.api.settings.reset().then(() => notify('Instellingen teruggezet. Herstart de app.', 'ok'))
          }}
        >
          Terug naar standaardinstellingen
        </button>
      </div>
    </>
  )
}
