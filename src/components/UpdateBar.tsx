import type { JSX } from 'react'
import type { UpdateStatus } from '../../shared/types'

interface Props {
  status: UpdateStatus
}

/**
 * Onopvallende balk onderin de zijbalk. Verschijnt alleen als er echt iets te
 * melden valt — bij 'actueel' of tijdens het zoeken hoeft niemand iets te zien.
 */
export default function UpdateBar({ status }: Props): JSX.Element | null {
  if (status.state === 'beschikbaar') {
    return (
      <div className="update-bar">
        <div className="update-title">Versie {status.version} is er</div>
        <button className="btn primary sm" style={{ width: '100%', marginTop: 7 }} onClick={() => void window.api.update.download()}>
          Downloaden
        </button>
      </div>
    )
  }

  if (status.state === 'downloaden') {
    return (
      <div className="update-bar">
        <div className="update-title">Bijwerken… {status.progress}%</div>
        <div className="bar" style={{ marginTop: 7 }}>
          <i style={{ width: status.progress + '%' }} />
        </div>
      </div>
    )
  }

  if (status.state === 'gereed') {
    return (
      <div className="update-bar">
        <div className="update-title">Versie {status.version} staat klaar</div>
        <button className="btn primary sm" style={{ width: '100%', marginTop: 7 }} onClick={() => void window.api.update.install()}>
          Herstarten en installeren
        </button>
      </div>
    )
  }

  return null
}
