import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { formatTime, parseTime } from '../lib/format'
import type { Segment } from '../../shared/types'

interface Props {
  segments: Segment[]
  duration: number
  onChange: (segments: Segment[]) => void
}

/**
 * Tijdvelden bewerken als tekst en pas bij blur omzetten, anders vecht de
 * formatter met wat je aan het typen bent.
 */
function TimeCell({
  value,
  placeholder,
  onCommit
}: {
  value: number | null
  placeholder: string
  onCommit: (seconds: number | null) => void
}): JSX.Element {
  const [text, setText] = useState(formatTime(value))
  const [bad, setBad] = useState(false)

  useEffect(() => setText(formatTime(value)), [value])

  const commit = (): void => {
    const trimmed = text.trim()
    if (!trimmed) {
      setBad(false)
      onCommit(null)
      return
    }
    const parsed = parseTime(trimmed)
    if (parsed === null) {
      setBad(true)
      return
    }
    setBad(false)
    onCommit(parsed)
  }

  return (
    <input
      type="text"
      className="time-input"
      value={text}
      placeholder={placeholder}
      style={bad ? { borderColor: 'var(--err)' } : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
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

  return (
    <table className="seg-table">
      <thead>
        <tr>
          <th className="col-on" />
          <th className="col-nr">#</th>
          <th style={{ width: 96 }}>Van</th>
          <th style={{ width: 96 }}>Tot</th>
          <th style={{ width: '32%' }}>Artiest</th>
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
                  placeholder="begin"
                  onCommit={(v) => patch(seg.id, { start: v })}
                />
              </td>
              <td>
                <TimeCell value={seg.end} placeholder="eind" onCommit={(v) => patch(seg.id, { end: v })} />
              </td>
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
