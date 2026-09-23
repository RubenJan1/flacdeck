import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Settings } from '../../shared/types'

function defaults(): Settings {
  return {
    simpleMode: true,
    outputDir: path.join(app.getPath('music'), 'FlacDeck'),
    naming: '{artist} - {title}',
    concurrency: 2,
    audio: {
      compression: 8,
      sampleRate: 'source',
      bitDepth: 'source',
      channels: 'source',
      normalize: false,
      targetLufs: -14,
      fadeIn: 0,
      fadeOut: 0
    },
    usb: {
      layout: 'dj',
      asciiNames: false,
      createM3u: true
    },
    cookiesFromBrowser: '',
    proxy: '',
    keepSource: false
  }
}

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

/** Diep samenvoegen zodat nieuwe instellingen na een update ook waarden krijgen. */
function merge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue
    const current = out[k]
    out[k] =
      current && typeof current === 'object' && !Array.isArray(current) ? merge(current, v) : v
  }
  return out as T
}

let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return cache
  try {
    cache = merge(defaults(), JSON.parse(fs.readFileSync(file(), 'utf8')))
  } catch {
    cache = defaults()
  }
  return cache
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = merge(getSettings(), patch)
  cache = next
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* niet fataal: app werkt door met de instellingen in het geheugen */
  }
  return next
}

export function resetSettings(): Settings {
  cache = defaults()
  return saveSettings({})
}
