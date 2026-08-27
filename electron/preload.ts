import { contextBridge, ipcRenderer } from 'electron'
import type {
  BinaryStatus,
  DriveInfo,
  ExportLayout,
  ExportRequest,
  ExportResult,
  Job,
  JobRequest,
  LibraryItem,
  LicenceStatus,
  ProbeResult,
  Segment,
  Settings,
  TrackMeta,
  UpdateStatus
} from '../shared/types'

const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    save: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:save', patch),
    reset: (): Promise<Settings> => ipcRenderer.invoke('settings:reset')
  },
  update: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
    download: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:download'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    onStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
      const handler = (_e: unknown, s: UpdateStatus): void => cb(s)
      ipcRenderer.on('update:status', handler)
      return () => ipcRenderer.removeListener('update:status', handler)
    }
  },
  licence: {
    status: (): Promise<LicenceStatus> => ipcRenderer.invoke('licence:status'),
    activate: (key: string): Promise<LicenceStatus> => ipcRenderer.invoke('licence:activate', key),
    deactivate: (): Promise<LicenceStatus> => ipcRenderer.invoke('licence:deactivate')
  },
  binaries: {
    status: (): Promise<BinaryStatus> => ipcRenderer.invoke('bin:status'),
    installYtdlp: (): Promise<string> => ipcRenderer.invoke('bin:install-ytdlp'),
    onProgress: (cb: (pct: number) => void): (() => void) => {
      const handler = (_e: unknown, pct: number): void => cb(pct)
      ipcRenderer.on('ytdlp:progress', handler)
      return () => ipcRenderer.removeListener('ytdlp:progress', handler)
    }
  },
  source: {
    probe: (url: string): Promise<ProbeResult> => ipcRenderer.invoke('probe:url', url),
    playlist: (url: string): Promise<string[]> => ipcRenderer.invoke('probe:playlist', url),
    parseTracklist: (
      text: string,
      base: Partial<TrackMeta>,
      duration: number
    ): Promise<Segment[]> => ipcRenderer.invoke('tracklist:parse', text, base, duration)
  },
  queue: {
    add: (req: JobRequest, sourceDuration: number): Promise<string[]> =>
      ipcRenderer.invoke('queue:add', req, sourceDuration),
    list: (): Promise<Job[]> => ipcRenderer.invoke('queue:list'),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke('queue:cancel', id),
    cancelAll: (): Promise<void> => ipcRenderer.invoke('queue:cancel-all'),
    retry: (id: string): Promise<void> => ipcRenderer.invoke('queue:retry', id),
    clearFinished: (): Promise<void> => ipcRenderer.invoke('queue:clear'),
    onJob: (cb: (job: Job) => void): (() => void) => {
      const handler = (_e: unknown, job: Job): void => cb(job)
      ipcRenderer.on('queue:job', handler)
      return () => ipcRenderer.removeListener('queue:job', handler)
    },
    onRemoved: (cb: (id: string) => void): (() => void) => {
      const handler = (_e: unknown, id: string): void => cb(id)
      ipcRenderer.on('queue:removed', handler)
      return () => ipcRenderer.removeListener('queue:removed', handler)
    }
  },
  library: {
    scan: (dir?: string): Promise<LibraryItem[]> => ipcRenderer.invoke('library:scan', dir),
    remove: (paths: string[]): Promise<number> => ipcRenderer.invoke('library:delete', paths),
    reveal: (file: string): Promise<void> => ipcRenderer.invoke('library:reveal', file),
    play: (file: string): Promise<void> => ipcRenderer.invoke('library:play', file)
  },
  usb: {
    drives: (): Promise<DriveInfo[]> => ipcRenderer.invoke('usb:drives'),
    layouts: (): Promise<{ id: ExportLayout; label: string; hint: string }[]> =>
      ipcRenderer.invoke('usb:layouts'),
    size: (paths: string[]): Promise<number> => ipcRenderer.invoke('usb:size', paths),
    exportTracks: (req: ExportRequest): Promise<ExportResult> => ipcRenderer.invoke('usb:export', req),
    onProgress: (cb: (p: { done: number; total: number; current: string }) => void): (() => void) => {
      const handler = (_e: unknown, p: { done: number; total: number; current: string }): void => cb(p)
      ipcRenderer.on('usb:progress', handler)
      return () => ipcRenderer.removeListener('usb:progress', handler)
    }
  },
  dialog: {
    pickDirectory: (title?: string): Promise<string | null> => ipcRenderer.invoke('dialog:dir', title),
    pickImage: (): Promise<string | null> => ipcRenderer.invoke('dialog:image')
  },
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
    openPath: (p: string): Promise<void> => ipcRenderer.invoke('shell:open-path', p)
  },
  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    platform: process.platform
  }
}

export type FlacDeckApi = typeof api

contextBridge.exposeInMainWorld('api', api)
