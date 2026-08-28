import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Download from './components/Download'
import Queue from './components/Queue'
import Library from './components/Library'
import SettingsPanel from './components/SettingsPanel'
import Setup from './components/Setup'
import Activate from './components/Activate'
import UpdateBar from './components/UpdateBar'
import type { BinaryStatus, Job, LicenceStatus, Settings, UpdateStatus } from '../shared/types'

export type Tab = 'download' | 'queue' | 'library' | 'settings'

export interface Toast {
  text: string
  kind: 'ok' | 'err' | 'info'
}

const NAV: { id: Tab; label: string; icon: string }[] = [
  { id: 'download', label: 'Downloaden', icon: '↓' },
  { id: 'queue', label: 'Wachtrij', icon: '≡' },
  { id: 'library', label: 'Bibliotheek & USB', icon: '▣' },
  { id: 'settings', label: 'Instellingen', icon: '⚙' }
]

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('download')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [binaries, setBinaries] = useState<BinaryStatus | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [toast, setToast] = useState<Toast | null>(null)
  const [version, setVersion] = useState('')
  const [licence, setLicence] = useState<LicenceStatus | null>(null)
  const [update, setUpdate] = useState<UpdateStatus>({
    state: 'idle',
    version: '',
    notes: '',
    progress: 0,
    error: ''
  })
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const notify = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    setToast({ text, kind })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 5200)
  }, [])

  const refreshBinaries = useCallback(async () => {
    setBinaries(await window.api.binaries.status())
  }, [])

  useEffect(() => {
    void (async () => {
      setLicence(await window.api.licence.status())
      setSettings(await window.api.settings.get())
      setJobs(await window.api.queue.list())
      setVersion(await window.api.app.version())
      setUpdate(await window.api.update.status())
      await refreshBinaries()
    })()

    const offUpdate = window.api.update.onStatus(setUpdate)

    const offJob = window.api.queue.onJob((job) => {
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.id === job.id)
        if (idx === -1) return [...prev, job]
        const next = [...prev]
        next[idx] = job
        return next
      })
    })
    const offRemoved = window.api.queue.onRemoved((id) => {
      setJobs((prev) => prev.filter((j) => j.id !== id))
    })
    return () => {
      offJob()
      offRemoved()
      offUpdate()
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [refreshBinaries])

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await window.api.settings.save(patch))
  }, [])

  const activeCount = useMemo(
    () => jobs.filter((j) => ['wachtrij', 'ophalen', 'downloaden', 'knippen', 'taggen'].includes(j.status)).length,
    [jobs]
  )
  const doneCount = useMemo(() => jobs.filter((j) => j.status === 'klaar').length, [jobs])

  if (!settings || !licence) {
    return (
      <div className="empty" style={{ paddingTop: 140 }}>
        <span className="spin" /> <span style={{ marginLeft: 8 }}>FlacDeck start op…</span>
      </div>
    )
  }

  if (!licence.valid) return <Activate onActivated={setLicence} />

  const needsSetup = binaries !== null && !binaries.ytdlp.ok

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">FD</div>
          <div>
            <div className="brand-name">FlacDeck</div>
            <div className="brand-sub">YouTube → FLAC → USB</div>
          </div>
        </div>

        {NAV.map((item) => (
          <button
            key={item.id}
            className={'nav-item' + (tab === item.id ? ' active' : '')}
            onClick={() => setTab(item.id)}
          >
            <span aria-hidden style={{ width: 14, textAlign: 'center', opacity: 0.8 }}>
              {item.icon}
            </span>
            {item.label}
            {item.id === 'queue' && activeCount > 0 && <span className="nav-badge">{activeCount}</span>}
            {item.id === 'library' && activeCount === 0 && doneCount > 0 && (
              <span className="nav-badge">{doneCount}</span>
            )}
          </button>
        ))}

        <div style={{ marginTop: 'auto' }}>
          <UpdateBar status={update} />
        </div>

        <div className="sidebar-foot" style={{ marginTop: 0 }}>
          {licence.info?.name && <div>op naam van {licence.info.name}</div>}
          <div>versie {version || '—'}</div>
          <div>yt-dlp {binaries?.ytdlp.ok ? binaries.ytdlp.version : 'niet geïnstalleerd'}</div>
        </div>
      </aside>

      <main className="main">
        {needsSetup ? (
          <Setup binaries={binaries} onReady={refreshBinaries} notify={notify} />
        ) : (
          <>
            {tab === 'download' && (
              <Download settings={settings} notify={notify} goToQueue={() => setTab('queue')} />
            )}
            {tab === 'queue' && <Queue jobs={jobs} notify={notify} goToLibrary={() => setTab('library')} />}
            {tab === 'library' && <Library settings={settings} notify={notify} />}
            {tab === 'settings' && (
              <SettingsPanel
                settings={settings}
                binaries={binaries}
                licence={licence}
                onChange={updateSettings}
                onBinariesChanged={refreshBinaries}
                onLicenceChanged={setLicence}
                notify={notify}
              />
            )}
          </>
        )}
      </main>

      {toast && <div className={'toast ' + toast.kind}>{toast.text}</div>}
    </div>
  )
}
