import type { JSX } from 'react'
import { useState } from 'react'
import type { LicenceStatus } from '../../shared/types'

interface Props {
  onActivated: (status: LicenceStatus) => void
}

/** Toegangspoort: zonder geldige sleutel komt er niets door. */
export default function Activate({ onActivated }: Props): JSX.Element {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (): Promise<void> => {
    if (!key.trim()) return
    setBusy(true)
    setError('')
    try {
      const status = await window.api.licence.activate(key)
      if (status.valid) onActivated(status)
      else setError(status.reason)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="brand" style={{ padding: '0 0 18px' }}>
          <div className="brand-mark">FD</div>
          <div>
            <div className="brand-name">FlacDeck</div>
            <div className="brand-sub">YouTube → FLAC → USB</div>
          </div>
        </div>

        <h1 style={{ fontSize: 19, margin: '0 0 6px' }}>Toegangssleutel</h1>
        <p className="muted small" style={{ marginTop: 0 }}>
          Plak de sleutel die je hebt gekregen. Dat hoeft maar één keer per computer; daarna
          onthoudt FlacDeck hem.
        </p>

        <div className="note" style={{ marginTop: 12 }}>
          Toegang tot deze app kost <strong style={{ color: 'var(--accent)' }}>€ 40,-</strong>.
          Nog geen sleutel? Neem contact op met{' '}
          <strong style={{ color: 'var(--text)' }}>RJ Websites</strong> — dan regelen we het.
        </div>

        <textarea
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="FD1.…"
          spellCheck={false}
          style={{ minHeight: 96, marginTop: 10 }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
          }}
        />

        {error && (
          <div className="note err" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <span className="faint small">Regeleindes en spaties maken niet uit.</span>
          <div className="spacer" />
          <button className="btn primary" onClick={() => void submit()} disabled={busy || !key.trim()}>
            {busy ? 'Controleren…' : 'Ontgrendelen'}
          </button>
        </div>
      </div>
    </div>
  )
}
