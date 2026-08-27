import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { binaryStatus, installYtdlp } from './services/binaries'
import { deleteTracks, scanLibrary } from './services/library'
import { activate, currentStatus, deactivate, requireLicence } from './services/licence'
import { queue } from './services/queue'
import { getSettings, resetSettings, saveSettings } from './services/store'
import { segmentsFromText } from './services/tracklist'
import { exportSize, exportTracks, layoutOptions, listDrives } from './services/usb'
import { playlistUrls, probe } from './services/ytdlp'
import type { ExportRequest, JobRequest, Settings, TrackMeta } from '../shared/types'

let mainWindow: BrowserWindow | null = null

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1116',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/* --------------------------------- IPC ----------------------------------- */

function registerIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', (_e, patch: Partial<Settings>) => saveSettings(patch))
  ipcMain.handle('settings:reset', () => resetSettings())

  ipcMain.handle('bin:status', () => binaryStatus())
  ipcMain.handle('bin:install-ytdlp', async () => {
    const result = await installYtdlp((pct) => send('ytdlp:progress', pct))
    send('ytdlp:progress', 100)
    return result
  })

  ipcMain.handle('licence:status', () => currentStatus())
  ipcMain.handle('licence:activate', (_e, key: string) => activate(key))
  ipcMain.handle('licence:deactivate', () => {
    deactivate()
    return currentStatus()
  })

  ipcMain.handle('probe:url', (_e, url: string) => {
    requireLicence()
    return probe(url.trim(), getSettings())
  })
  ipcMain.handle('probe:playlist', (_e, url: string) => {
    requireLicence()
    return playlistUrls(url.trim(), getSettings())
  })
  ipcMain.handle(
    'tracklist:parse',
    (_e, text: string, base: Partial<TrackMeta>, duration: number) =>
      segmentsFromText(text, base ?? {}, duration ?? 0)
  )

  ipcMain.handle('queue:add', (_e, req: JobRequest, sourceDuration: number) => {
    requireLicence()
    return queue.add(req, getSettings(), sourceDuration ?? 0)
  })
  ipcMain.handle('queue:list', () => queue.list())
  ipcMain.handle('queue:cancel', (_e, id: string) => queue.cancel(id))
  ipcMain.handle('queue:cancel-all', () => queue.cancelAll())
  ipcMain.handle('queue:retry', (_e, id: string) => queue.retry(id))
  ipcMain.handle('queue:clear', () => queue.clearFinished())

  ipcMain.handle('library:scan', (_e, dir?: string) => scanLibrary(dir || getSettings().outputDir))
  ipcMain.handle('library:delete', async (_e, paths: string[]) => {
    if (!paths.length) return 0
    // Definitief weggooien: eerst laten bevestigen, en niet de gevaarlijke knop
    // als standaardkeuze zetten.
    const { response } = await dialog.showMessageBox(mainWindow ?? undefined!, {
      type: 'warning',
      buttons: ['Annuleren', 'Verwijderen'],
      defaultId: 0,
      cancelId: 0,
      title: 'Bestanden verwijderen',
      message:
        paths.length === 1
          ? 'Dit bestand definitief verwijderen?'
          : paths.length + ' bestanden definitief verwijderen?',
      detail: 'Ze gaan niet naar de prullenbak en kunnen niet worden teruggezet.'
    })
    if (response !== 1) return 0
    return deleteTracks(paths)
  })
  ipcMain.handle('library:reveal', (_e, file: string) => shell.showItemInFolder(file))
  ipcMain.handle('library:play', (_e, file: string) => shell.openPath(file))

  ipcMain.handle('usb:drives', () => listDrives())
  ipcMain.handle('usb:layouts', () => layoutOptions())
  ipcMain.handle('usb:size', (_e, paths: string[]) => exportSize(paths))
  ipcMain.handle('usb:export', (_e, req: ExportRequest) => {
    requireLicence()
    return exportTracks(req, (done, total, current) => send('usb:progress', { done, total, current }))
  })

  ipcMain.handle('dialog:dir', async (_e, title?: string) => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Kies een map',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('dialog:image', async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Kies een hoesafbeelding',
      properties: ['openFile'],
      filters: [{ name: 'Afbeeldingen', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('shell:open-external', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })
  ipcMain.handle('shell:open-path', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('app:version', () => app.getVersion())
}

/* -------------------------------- opstart -------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    registerIpc()

    queue.on('job', (job) => send('queue:job', job))
    queue.on('removed', (id) => send('queue:removed', id))

    // Zorg dat de outputmap bestaat voor de eerste download.
    await fsp.mkdir(getSettings().outputDir, { recursive: true }).catch(() => undefined)

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    queue.cancelAll()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => queue.cancelAll())
}
