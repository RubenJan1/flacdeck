import type { JSX } from 'react'
import { formatBytes } from '../lib/format'
import type { UnreadableStick } from '../../shared/types'

interface Props {
  sticks: UnreadableStick[]
  className?: string
}

/**
 * Een stick die erin zit maar niet in de lijst verschijnt. Zonder deze melding
 * denkt de gebruiker dat FlacDeck kapot is, of de stick.
 */
export default function UnreadableSticks({ sticks, className = '' }: Props): JSX.Element | null {
  if (!sticks.length) return null
  return (
    <>
      {sticks.map((s, i) => (
        <div key={s.name + i} className={'note err ' + className}>
          <strong>{s.title}</strong>
          <div className="small" style={{ marginTop: 2 }}>
            {s.name}
            {s.totalBytes > 0 ? ' · ' + formatBytes(s.totalBytes) : ''}
          </div>
          <div style={{ marginTop: 6 }}>{s.message}</div>
          {s.fix && <div style={{ marginTop: 8 }}>{s.fix}</div>}
        </div>
      ))}
    </>
  )
}
