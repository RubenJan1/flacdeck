import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { mediaInfo } from './audio'
import type { LibraryItem } from '../../shared/types'

async function walk(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return []
  let entries: Dirent[] = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(full, depth + 1)))
    else if (entry.name.toLowerCase().endsWith('.flac')) files.push(full)
  }
  return files
}

/** Leest de outputmap uit; tags komen uit de bestanden zelf. */
export async function scanLibrary(dir: string): Promise<LibraryItem[]> {
  const files = await walk(dir)
  const items = await Promise.all(
    files.map(async (file): Promise<LibraryItem | null> => {
      try {
        const [stat, info] = await Promise.all([fsp.stat(file), mediaInfo(file)])
        const t = info.tags
        return {
          path: file,
          name: path.basename(file),
          size: stat.size,
          mtime: stat.mtimeMs,
          duration: info.duration,
          meta: {
            artist: t.ARTIST ?? '',
            title: t.TITLE ?? path.basename(file, '.flac'),
            album: t.ALBUM ?? '',
            albumArtist: t.ALBUM_ARTIST ?? t.ALBUMARTIST ?? '',
            genre: t.GENRE ?? '',
            year: (t.DATE ?? t.YEAR ?? '').slice(0, 4),
            bpm: t.BPM ?? '',
            initialKey: t.INITIALKEY ?? t.KEY ?? ''
          }
        }
      } catch {
        return null
      }
    })
  )
  return items.filter((i): i is LibraryItem => i !== null).sort((a, b) => b.mtime - a.mtime)
}

export async function deleteTracks(paths: string[]): Promise<number> {
  let removed = 0
  for (const p of paths) {
    try {
      await fsp.rm(p, { force: true })
      removed += 1
    } catch {
      /* al weg of vergrendeld */
    }
  }
  return removed
}
