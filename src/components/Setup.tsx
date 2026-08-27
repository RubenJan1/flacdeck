import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { Toast } from '../App'

interface Props {
  onReady: () => Promise<void>
  notify: (text: string, kind?: Toast['kind']) => void
}

/** Eerste start: yt-dlp ophalen. Zonder die binary werkt de rest niet. */
export default function Setup({ onReady, notify }: Props): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => window.api.binaries.onProgress(setPct), [])

  const install = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.api.binaries.installYtdlp()
      await onReady()
      notify('yt-dlp geïnstalleerd, je kunt beginnen.', 'ok')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Eenmalig instellen</h1>
        <p>
          FlacDeck gebruikt <span className="mono">yt-dlp</span> om audio op te halen. Die haal ik één keer
          op bij het officiële project op GitHub; ffmpeg zit al in de app.
        </p>
      </div>

      <div className="card" style={{ maxWidth: 620 }}>
        <div className="card-title">yt-dlp installeren</div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Ongeveer 15 MB. Wordt opgeslagen in je gebruikersmap, niet in Program Files, dus je hebt geen
          beheerdersrechten nodig.
        </p>

        {busy && (
          <div className="bar" style={{ margin: '14px 0' }}>
            <i style={{ width: pct + '%' }} />
          </div>
        )}

        {error && (
          <div className="note err" style={{ marginBottom: 12 }}>
            Downloaden mislukt: {error}
            <br />
            Zit je achter een proxy of firewall? Dan kun je yt-dlp handmatig plaatsen — zie de README.
          </div>
        )}

        <button className="btn primary" onClick={install} disabled={busy}>
          {busy ? 'Bezig… ' + pct + '%' : 'Installeer yt-dlp'}
        </button>
      </div>
    </>
  )
}
