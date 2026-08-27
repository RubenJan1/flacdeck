import type { JSX } from 'react'
import { useMemo } from 'react'
import { formatBytes, formatTime } from '../lib/format'
import type { Job } from '../../shared/types'
import type { Toast } from '../App'

interface Props {
  jobs: Job[]
  notify: (text: string, kind?: Toast['kind']) => void
  goToLibrary: () => void
}

const ACTIVE = ['wachtrij', 'ophalen', 'downloaden', 'knippen', 'taggen']

function range(job: Job): string {
  if (job.start === null && job.end === null) return 'hele video'
  return `${formatTime(job.start ?? 0)} – ${job.end === null ? 'eind' : formatTime(job.end)}`
}

export default function Queue({ jobs, notify, goToLibrary }: Props): JSX.Element {
  const active = useMemo(() => jobs.filter((j) => ACTIVE.includes(j.status)), [jobs])
  const finished = useMemo(() => jobs.filter((j) => !ACTIVE.includes(j.status)), [jobs])
  const failed = finished.filter((j) => j.status === 'fout')

  if (!jobs.length) {
    return (
      <>
        <div className="page-head">
          <h1>Wachtrij</h1>
        </div>
        <div className="empty">
          Niets in de wachtrij. Plak een link op het tabblad <strong>Downloaden</strong>.
        </div>
      </>
    )
  }

  return (
    <>
      <div className="page-head">
        <h1>Wachtrij</h1>
        <p>
          {active.length ? `${active.length} bezig` : 'Alles verwerkt'} · {finished.length} afgerond
          {failed.length ? ` · ${failed.length} mislukt` : ''}
        </p>
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn sm" onClick={() => void window.api.queue.cancelAll()} disabled={!active.length}>
          Alles stoppen
        </button>
        <button
          className="btn sm"
          onClick={() => void window.api.queue.clearFinished()}
          disabled={!finished.length}
        >
          Afgeronde opruimen
        </button>
        <div className="spacer" />
        <button className="btn sm" onClick={goToLibrary}>
          Naar bibliotheek →
        </button>
      </div>

      {jobs.map((job) => (
        <div className="job" key={job.id}>
          <div className="job-main">
            <div className="job-title">
              {job.meta.artist ? `${job.meta.artist} — ` : ''}
              {job.meta.title || job.sourceTitle}
            </div>
            <div className="job-sub">
              {range(job)} · {job.stage}
              {job.fileSize ? ` · ${formatBytes(job.fileSize)}` : ''}
            </div>
            {job.error ? (
              <div className="note err small" style={{ marginTop: 8 }}>
                {job.error}
              </div>
            ) : (
              <div className={'bar' + (job.status === 'klaar' ? ' done' : '')}>
                <i style={{ width: (job.status === 'klaar' ? 100 : job.progress) + '%' }} />
              </div>
            )}
          </div>

          <div className={'status ' + job.status}>{job.status}</div>

          {ACTIVE.includes(job.status) ? (
            <button className="btn sm ghost" onClick={() => void window.api.queue.cancel(job.id)}>
              Stop
            </button>
          ) : job.status === 'klaar' && job.outputPath ? (
            <button
              className="btn sm ghost"
              onClick={() => void window.api.library.reveal(job.outputPath as string)}
            >
              Toon
            </button>
          ) : (
            <button
              className="btn sm ghost"
              onClick={() => {
                window.api.queue.retry(job.id).catch(() => notify('Opnieuw proberen lukte niet.', 'err'))
              }}
            >
              Opnieuw
            </button>
          )}
        </div>
      ))}
    </>
  )
}
