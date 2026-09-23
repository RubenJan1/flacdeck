import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { formatTime } from '../lib/format'
import type { Segment } from '../../shared/types'

interface Props {
  segments: Segment[]
  duration: number
  onChange: (segments: Segment[]) => void
}

/**
 * Tijd invullen in twee losse vakjes: minuten en seconden.
 *
 * Eén tekstveld leek handiger, maar wie "3" intikte omdat hij drie minuten
 * bedoelde kreeg drie seconden — en merkte dat pas als de nummers al geknipt
 * waren. Met een eigen vakje per eenheid kan dat niet meer misgaan.
 */
function TimeCell({
  value,
  onCommit,
  label
}: {
  value: number | null
  onCommit: (seconds: number | null) => void
  label: string
}): JSX.Element {
  const [min, setMin] = useState('')
  const [sec, setSec] = useState('')

  useEffect(() => {
    if (value === null) {
      setMin('')
      setSec('')
      return
    }
    const total = Math.max(0, Math.round(value))
    setMin(String(Math.floor(total / 60)))
    setSec(String(total % 60).padStart(2, '0'))
  }, [value])

  const digits = (raw: string): string => raw.replace(/\D/g, '').slice(0, 4)

  const push = (nextMin: string, nextSec: string): void => {
    if (!nextMin && !nextSec) {
      onCommit(null)
      return
    }
    // 90 seconden is gewoon anderhalve minuut; dat hoeft niemand zelf om te
    // rekenen, dus rekenen we door in plaats van een foutmelding te geven.
    onCommit(Number(nextMin || 0) * 60 + Number(nextSec || 0))
  }

  return (
    <span className="time-cell">
      <span className="time-part">
        <input
          type="text"
          inputMode="numeric"
          className="time-num"
          value={min}
          placeholder="0"
          aria-label={label + ' — minuten'}
          onChange={(e) => {
            const next = digits(e.target.value)
            setMin(next)
            push(next, sec)
          }}
        />
        <span className="time-unit">min</span>
      </span>
      <span className="time-colon">:</span>
      <span className="time-part">
        <input
          type="text"
          inputMode="numeric"
          className="time-num"
          value={sec}
          placeholder="00"
          aria-label={label + ' — seconden'}
          onChange={(e) => {
            const next = digits(e.target.value)
            setSec(next)
            push(min, next)
          }}
          onBlur={() => {
            if (sec && Number(sec) > 59) push(min, sec)
            else if (sec) setSec(sec.padStart(2, '0'))
          }}
        />
        <span className="time-unit">sec</span>
      </span>
    </span>
  )
}

export default function SegmentTable({ segments, duration, onChange }: Props): JSX.Element {
  const patch = (id: string, next: Partial<Segment>): void => {
    onChange(segments.map((s) => (s.id === id ? { ...s, ...next } : s)))
  }

  const patchMeta = (id: string, key: 'artist' | 'title', value: string): void => {
    onChange(segments.map((s) => (s.id === id ? { ...s, meta: { ...s.meta, [key]: value } } : s)))
  }

  const remove = (id: string): void => {
    onChange(segments.filter((s) => s.id !== id))
  }

  const problem = (seg: Segment, index: number): string => {
    if (!seg.enabled) return ''
    if (!seg.meta.title.trim()) return 'Titel is leeg'
    if (seg.start !== null && seg.end !== null && seg.end <= seg.start) return 'Eindtijd ligt voor de starttijd'
    if (duration > 0 && seg.start !== null && seg.start >= duration) return 'Starttijd ligt na het einde van de video'
    const prev = segments[index - 1]
    if (prev?.enabled && prev.end !== null && seg.start !== null && seg.start < prev.end) {
      return 'Overlapt met de vorige track'
    }
    return ''
  }

  /** Hoe lang het nummer wordt, zodat een vergissing meteen opvalt. */
  const length = (seg: Segment): string => {
    const from = seg.start ?? 0
    const to = seg.end ?? (duration > 0 ? duration : null)
    if (to === null || to <= from) return '—'
    return formatTime(to - from)
  }

  return (
    <table className="seg-table">
      <thead>
        <tr>
          <th className="col-on" />
          <th className="col-nr">#</th>
          <th style={{ width: 150 }}>Begint op</th>
          <th style={{ width: 150 }}>Stopt op</th>
          <th style={{ width: 70 }}>Duur</th>
          <th style={{ width: '28%' }}>Artiest</th>
          <th>Titel</th>
          <th className="col-act" />
        </tr>
      </thead>
      <tbody>
        {segments.map((seg, i) => {
          const issue = problem(seg, i)
          return (
            <tr key={seg.id} className={seg.enabled ? '' : 'off'}>
              <td>
                <input
                  type="checkbox"
                  checked={seg.enabled}
                  style={{ accentColor: 'var(--accent)' }}
                  onChange={(e) => patch(seg.id, { enabled: e.target.checked })}
                  aria-label="Track meenemen"
                />
              </td>
              <td className="col-nr">{i + 1}</td>
              <td>
                <TimeCell
                  value={seg.start}
                  label={'Track ' + (i + 1) + ' begint op'}
                  onCommit={(v) => patch(seg.id, { start: v })}
                />
              </td>
              <td>
                <TimeCell
                  value={seg.end}
                  label={'Track ' + (i + 1) + ' stopt op'}
                  onCommit={(v) => patch(seg.id, { end: v })}
                />
              </td>
              <td className="faint small mono">{length(seg)}</td>
              <td>
                <input
                  type="text"
                  value={seg.meta.artist}
                  placeholder="Artiest"
                  onChange={(e) => patchMeta(seg.id, 'artist', e.target.value)}
                />
              </td>
              <td>
                <input
                  type="text"
                  value={seg.meta.title}
                  placeholder="Titel"
                  onChange={(e) => patchMeta(seg.id, 'title', e.target.value)}
                  style={issue ? { borderColor: 'var(--err)' } : undefined}
                  title={issue}
                />
              </td>
              <td className="col-act">
                <button
                  className="btn ghost icon sm"
                  onClick={() => remove(seg.id)}
                  title="Rij verwijderen"
                  aria-label="Rij verwijderen"
                >
                  ✕
                </button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
