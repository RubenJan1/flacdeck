import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatBytes, formatTime } from '../lib/format'
import type {
  DriveCheck,
  DriveInfo,
  ExportLayout,
  ExportResult,
  LibraryItem,
  Settings
} from '../../shared/types'
import type { Toast } from '../App'

interface Props {
  settings: Settings
  notify: (text: string, kind?: Toast['kind']) => void
}

export default function Library({ settings, notify }: Props): JSX.Element {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [target, setTarget] = useState('')
  const [layouts, setLayouts] = useState<{ id: ExportLayout; label: string; hint: string }[]>([])
  const [layout, setLayout] = useState<ExportLayout>(settings.usb.layout)
  const [ascii, setAscii] = useState(settings.usb.asciiNames)
  const [m3u, setM3u] = useState(settings.usb.createM3u)
  const [playlistName, setPlaylistName] = useState('FlacDeck')
  const [overwrite, setOverwrite] = useState(false)

  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' })
  const [result, setResult] = useState<ExportResult | null>(null)
  const [check, setCheck] = useState<DriveCheck | null>(null)
  const [ejecting, setEjecting] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await window.api.library.scan())
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshDrives = useCallback(async () => {
    const found = await window.api.usb.drives()
    setDrives(found)
    setTarget((current) => (current && found.some((d) => d.path === current) ? current : found.find((d) => d.removable)?.path ?? ''))
  }, [])

  useEffect(() => {
    void refresh()
    void refreshDrives()
    void window.api.usb.layouts().then(setLayouts)
    return window.api.usb.onProgress(setProgress)
  }, [refresh, refreshDrives])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) =>
      [i.meta.artist, i.meta.title, i.meta.album, i.name].join(' ').toLowerCase().includes(q)
    )
  }, [items, filter])

  const selectedPaths = useMemo(() => items.filter((i) => selected.has(i.path)).map((i) => i.path), [items, selected])
  const selectedBytes = useMemo(
    () => items.filter((i) => selected.has(i.path)).reduce((sum, i) => sum + i.size, 0),
    [items, selected]
  )

  const toggle = (path: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleAll = (): void => {
    setSelected((prev) => (prev.size === visible.length ? new Set() : new Set(visible.map((i) => i.path))))
  }

  // Vooraf kijken of deze stick te gebruiken is; pas achteraf waarschuwen
  // betekent dat er al een half uur gekopieerd is naar iets wat niets leest.
  useEffect(() => {
    if (!target) {
      setCheck(null)
      return
    }
    let current = true
    void window.api.usb.check(target, layout).then((c) => {
      if (current) setCheck(c)
    })
    return () => {
      current = false
    }
  }, [target, layout])

  const drive = drives.find((d) => d.path === target)
  const tooBig = Boolean(drive && drive.freeBytes > 0 && selectedBytes > drive.freeBytes)

  const eject = async (): Promise<void> => {
    setEjecting(true)
    try {
      const res = await window.api.usb.eject(target)
      notify(res.message, res.ok ? 'ok' : 'err')
      if (res.ok) {
        setResult(null)
        await refreshDrives()
      }
    } finally {
      setEjecting(false)
    }
  }

  const runExport = async (): Promise<void> => {
    if (!target || !selectedPaths.length) return
    setExporting(true)
    setResult(null)
    setProgress({ done: 0, total: selectedPaths.length, current: '' })
    void window.api.app.setBusy('FlacDeck is muziek naar de stick aan het kopiëren.')
    try {
      const res = await window.api.usb.exportTracks({
        paths: selectedPaths,
        target,
        layout,
        asciiNames: ascii,
        createM3u: m3u,
        playlistName,
        overwrite
      })
      setResult(res)
      await window.api.settings.save({ usb: { layout, asciiNames: ascii, createM3u: m3u } })
      notify(
        `${res.copied} gekopieerd${res.skipped ? `, ${res.skipped} overgeslagen` : ''}${
          res.failed.length ? `, ${res.failed.length} mislukt` : ''
        }.`,
        res.failed.length ? 'err' : 'ok'
      )
      await refreshDrives()
    } catch (err) {
      notify((err as Error).message, 'err')
    } finally {
      void window.api.app.setBusy('')
      setExporting(false)
    }
  }

  const removeSelected = async (): Promise<void> => {
    const count = await window.api.library.remove(selectedPaths)
    if (!count) return
    setSelected(new Set())
    await refresh()
    notify(`${count} bestand(en) verwijderd.`, 'ok')
  }

  return (
    <>
      <div className="page-head">
        <h1>Bibliotheek &amp; USB</h1>
        <p>
          Alles wat FlacDeck heeft gemaakt staat in <span className="mono">{settings.outputDir}</span>. Vink aan
          wat mee moet naar de stick en kies de mapindeling die je apparaat begrijpt.
        </p>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <input
            type="text"
            value={filter}
            placeholder="Zoeken op artiest, titel of album…"
            onChange={(e) => setFilter(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <button className="btn sm" onClick={toggleAll} disabled={!visible.length}>
            {selected.size === visible.length && visible.length ? 'Niets selecteren' : 'Alles selecteren'}
          </button>
          <button className="btn sm" onClick={() => void refresh()}>
            Vernieuwen
          </button>
          <div className="spacer" />
          <span className="muted small">
            {selected.size} van {items.length} · {formatBytes(selectedBytes)}
          </span>
          <button
            className="btn sm danger"
            onClick={() => void removeSelected()}
            disabled={!selected.size}
            title="Verwijdert de bestanden van je schijf"
          >
            Verwijderen
          </button>
        </div>

        {loading ? (
          <div className="empty">
            <span className="spin" />
          </div>
        ) : !items.length ? (
          <div className="empty">Nog geen FLAC-bestanden. Download eerst iets.</div>
        ) : (
          <div className="lib-list">
            {visible.map((item) => (
              <label className="lib-row" key={item.path}>
                <input
                  type="checkbox"
                  checked={selected.has(item.path)}
                  onChange={() => toggle(item.path)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="job-title">
                    {item.meta.artist ? `${item.meta.artist} — ` : ''}
                    {item.meta.title}
                  </div>
                  <div className="job-sub">
                    {[item.meta.album, item.meta.genre, item.meta.year].filter(Boolean).join(' · ') || item.name}
                  </div>
                </div>
                <span className="faint small mono">{formatTime(item.duration)}</span>
                <span className="faint small mono" style={{ width: 66, textAlign: 'right' }}>
                  {formatBytes(item.size)}
                </span>
                <button
                  className="btn sm ghost"
                  onClick={(e) => {
                    e.preventDefault()
                    void window.api.library.reveal(item.path)
                  }}
                >
                  Toon
                </button>
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="card-title" style={{ margin: 0 }}>
            Exporteren naar USB
          </div>
          <div className="spacer" />
          <button className="btn sm" onClick={() => void refreshDrives()}>
            Schijven verversen
          </button>
          <button
            className="btn sm"
            onClick={() =>
              void window.api.dialog.pickDirectory('Kies de map op de stick').then((dir) => {
                if (dir) setTarget(dir)
              })
            }
          >
            Map kiezen…
          </button>
        </div>

        {drives.length ? (
          drives.map((d) => {
            const used = d.totalBytes > 0 ? 1 - d.freeBytes / d.totalBytes : 0
            return (
              <button
                key={d.path}
                className={'drive' + (target === d.path ? ' selected' : '')}
                onClick={() => setTarget(d.path)}
              >
                <span style={{ fontSize: 17 }}>{d.removable ? '🔌' : '💽'}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="job-title">
                    {d.label} <span className="faint mono small">{d.path}</span>
                  </span>
                  <span className="job-sub">
                    {d.filesystem || 'onbekend bestandssysteem'} · {formatBytes(d.freeBytes)} vrij van{' '}
                    {formatBytes(d.totalBytes)}
                    {d.removable ? ' · verwisselbaar' : ''}
                  </span>
                </span>
                <span className="drive-meter">
                  <i style={{ width: Math.round(used * 100) + '%' }} />
                </span>
              </button>
            )
          })
        ) : (
          <div className="note">Geen schijven gevonden. Sluit een stick aan en klik op “Schijven verversen”.</div>
        )}

        {target && !drives.some((d) => d.path === target) && (
          <div className="note small mono" style={{ marginBottom: 10 }}>
            Doelmap: {target}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <div className="card-title">Mapindeling</div>
          {layouts.map((l) => (
            <label key={l.id} className={'layout-opt' + (layout === l.id ? ' selected' : '')}>
              <input
                type="radio"
                name="layout"
                checked={layout === l.id}
                onChange={() => setLayout(l.id)}
              />
              <span>
                <span style={{ fontWeight: 600 }}>{l.label}</span>
                <span className="job-sub" style={{ whiteSpace: 'normal' }}>
                  {l.hint}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="row row-wrap" style={{ marginTop: 14, gap: 18 }}>
          <label className="checkbox">
            <input type="checkbox" checked={ascii} onChange={(e) => setAscii(e.target.checked)} />
            Alleen simpele tekens in bestandsnamen
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={m3u} onChange={(e) => setM3u(e.target.checked)} />
            Playlist (.m3u8) meeschrijven
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            Bestaande bestanden overschrijven
          </label>
          {m3u && (
            <input
              type="text"
              value={playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
              style={{ maxWidth: 200 }}
              placeholder="Naam van de playlist"
            />
          )}
        </div>

        {check && check.level !== 'ok' && (
          <div className={'note ' + (check.level === 'block' ? 'err' : 'warn')} style={{ marginTop: 14 }}>
            <strong>{check.title}</strong> {check.message}
            {check.fix && <div style={{ marginTop: 6 }}>{check.fix}</div>}
          </div>
        )}

        {tooBig && (
          <div className="note err" style={{ marginTop: 14 }}>
            De selectie is {formatBytes(selectedBytes)} en er is maar {formatBytes(drive?.freeBytes ?? 0)} vrij.
          </div>
        )}

        {exporting && (
          <div style={{ marginTop: 14 }}>
            <div className="bar">
              <i style={{ width: progress.total ? (progress.done / progress.total) * 100 + '%' : '0%' }} />
            </div>
            <div className="faint small" style={{ marginTop: 6 }}>
              {progress.done} / {progress.total} — {progress.current}
            </div>
          </div>
        )}

        {result && (
          <div className={'note ' + (result.failed.length ? 'err' : 'ok')} style={{ marginTop: 14 }}>
            {result.copied} gekopieerd ({formatBytes(result.bytes)})
            {result.skipped ? `, ${result.skipped} al aanwezig` : ''}
            {result.playlistPath ? ` · playlist: ${result.playlistPath.split(/[\\/]/).pop()}` : ''}
            {result.failed.map((f) => (
              <div key={f.path} className="small mono" style={{ marginTop: 6 }}>
                {f.path.split(/[\\/]/).pop()}: {f.error}
              </div>
            ))}
          </div>
        )}

        {result?.warnings.map((w) => (
          <div key={w} className="note warn" style={{ marginTop: 10 }}>
            {w}
          </div>
        ))}

        {result && (
          <div className="note warn" style={{ marginTop: 14 }}>
            Trek de stick er nog niet uit. Koppel hem eerst los, anders staat er straks maar een deel van de
            muziek op.
          </div>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <div className="spacer" />
          <button
            className="btn"
            onClick={() => void eject()}
            disabled={ejecting || !target || exporting}
            title="Schrijft de laatste gegevens weg en koppelt de stick los"
          >
            {ejecting ? 'Bezig…' : 'Stick veilig uitwerpen'}
          </button>
          <button
            className="btn primary"
            onClick={() => void runExport()}
            disabled={exporting || !target || !selectedPaths.length || check?.level === 'block'}
          >
            {exporting ? 'Kopiëren…' : `Kopieer ${selectedPaths.length} bestand(en)`}
          </button>
        </div>
      </div>
    </>
  )
}
