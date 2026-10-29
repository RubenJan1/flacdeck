import { app } from 'electron'
import pkg from 'electron-updater'
import type { UpdateStatus } from '../../shared/types'

// electron-updater is CommonJS; de named export werkt niet met ESM-import.
const { autoUpdater } = pkg

// Moet gelijk zijn aan publish.owner/repo in electron-builder.yml; check:release
// kijkt dat na.
const RELEASES = 'https://github.com/RubenJan1/flacdeck/releases'

/**
 * Op macOS kan FlacDeck zichzelf niet bijwerken. electron-updater wil daar een
 * zip en vervangt alleen een ondertekende app, en wij hebben geen Apple
 * Developer-account. Zoeken werkt wel; de gebruiker krijgt dan een directe link
 * naar de dmg voor zijn soort Mac in plaats van een knop die op een fout uitloopt.
 */
const manual = process.platform === 'darwin'

function manualUrl(version: string): string {
  return RELEASES + '/download/v' + version + '/FlacDeck-' + version + '-macos-' + process.arch + '.dmg'
}

let status: UpdateStatus = { state: 'idle', version: '', notes: '', progress: 0, error: '', downloadUrl: '' }
let broadcast: ((s: UpdateStatus) => void) | null = null

function set(next: Partial<UpdateStatus>): void {
  status = { ...status, ...next }
  broadcast?.(status)
}

export function currentUpdateStatus(): UpdateStatus {
  return status
}

/**
 * Koppelt de updater aan de app. Downloaden gebeurt niet vanzelf: de gebruiker
 * krijgt eerst te zien dát er een versie is, en beslist zelf.
 */
export function initUpdater(send: (s: UpdateStatus) => void): void {
  broadcast = send

  // In ontwikkeling is er niets om bij te werken; de updater zou alleen klagen.
  if (!app.isPackaged) {
    set({ state: 'uit', error: '' })
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = !manual

  autoUpdater.on('checking-for-update', () => set({ state: 'zoeken', error: '' }))
  autoUpdater.on('update-available', (info) => {
    const version = String(info.version ?? '')
    set({
      state: 'beschikbaar',
      version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      error: '',
      downloadUrl: manual ? manualUrl(version) : ''
    })
  })
  autoUpdater.on('update-not-available', () => set({ state: 'actueel', error: '' }))
  autoUpdater.on('download-progress', (p) => set({ state: 'downloaden', progress: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) =>
    set({ state: 'gereed', version: String(info.version ?? ''), progress: 100, error: '' })
  )
  autoUpdater.on('error', (err) => set({ state: 'fout', error: err?.message ?? String(err) }))

  // Kort na de start één keer kijken, zonder de opstart te vertragen.
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => undefined)
  }, 4000)
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    set({ state: 'uit' })
    return status
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    set({ state: 'fout', error: (err as Error).message })
  }
  return status
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (status.state !== 'beschikbaar' || manual) return status
  try {
    set({ state: 'downloaden', progress: 0 })
    await autoUpdater.downloadUpdate()
  } catch (err) {
    set({ state: 'fout', error: (err as Error).message })
  }
  return status
}

/** Sluit de app af en installeert de gedownloade versie. */
export function installUpdate(): void {
  if (status.state !== 'gereed' || manual) return
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}
