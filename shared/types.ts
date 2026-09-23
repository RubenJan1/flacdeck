/** Gedeelde types tussen main- en renderer-proces. */

export interface Chapter {
  title: string
  start: number
  end: number
}

/** Vorbis-comment velden die we in de FLAC schrijven. */
export interface TrackMeta {
  artist: string
  title: string
  album: string
  albumArtist: string
  genre: string
  year: string
  trackNumber: string
  totalTracks: string
  bpm: string
  initialKey: string
  label: string
  comment: string
}

export function emptyMeta(): TrackMeta {
  return {
    artist: '',
    title: '',
    album: '',
    albumArtist: '',
    genre: '',
    year: '',
    trackNumber: '',
    totalTracks: '',
    bpm: '',
    initialKey: '',
    label: '',
    comment: ''
  }
}

/** Eén uit te knippen stuk van de bron. start/end in seconden, null = begin/eind. */
export interface Segment {
  id: string
  enabled: boolean
  start: number | null
  end: number | null
  meta: TrackMeta
}

export interface ProbeResult {
  id: string
  url: string
  webpageUrl: string
  title: string
  uploader: string
  uploadDate: string
  duration: number
  isLive: boolean
  wasLive: boolean
  thumbnail: string
  description: string
  chapters: Chapter[]
  /** Uit de videotitel geraden artiest/titel. */
  guess: { artist: string; title: string }
  /** Voorgestelde segmenten uit hoofdstukken of tijdstempels in de beschrijving. */
  suggestedSegments: Segment[]
  suggestionSource: 'chapters' | 'description' | 'none'
  /** Meerdere items = playlist-URL. */
  playlistCount: number
}

export interface AudioSettings {
  /** FLAC compressielevel 0-12. */
  compression: number
  sampleRate: 'source' | '44100' | '48000'
  bitDepth: 'source' | '16' | '24'
  channels: 'source' | 'stereo'
  /** Loudness-normalisatie (EBU R128). Standaard uit: DJ-spelers doen dit zelf. */
  normalize: boolean
  targetLufs: number
  fadeIn: number
  fadeOut: number
}

export type JobStatus =
  | 'wachtrij'
  | 'ophalen'
  | 'downloaden'
  | 'knippen'
  | 'taggen'
  | 'klaar'
  | 'fout'
  | 'geannuleerd'

export interface Job {
  id: string
  batchId: string
  url: string
  sourceTitle: string
  status: JobStatus
  stage: string
  progress: number
  error: string | null
  outputPath: string | null
  fileSize: number | null
  meta: TrackMeta
  start: number | null
  end: number | null
  createdAt: number
  finishedAt: number | null
}

export interface JobRequest {
  url: string
  sourceTitle: string
  /** Nog lopende livestream: yt-dlp moet dan vanaf het begin van de DVR lezen. */
  isLive: boolean
  segments: Segment[]
  coverMode: 'video' | 'file' | 'none'
  coverUrl: string
  coverFile: string
  squareCover: boolean
  audio: AudioSettings
}

export type ExportLayout = 'dj' | 'car' | 'flat' | 'library'

export interface ExportRequest {
  paths: string[]
  target: string
  layout: ExportLayout
  asciiNames: boolean
  createM3u: boolean
  playlistName: string
  overwrite: boolean
}

export interface ExportResult {
  copied: number
  skipped: number
  failed: { path: string; error: string }[]
  bytes: number
  playlistPath: string | null
  warnings: string[]
  /** Teruggelezen van de stick nadat alles geschreven was. */
  verified: number
  /** Bestanden die na het schrijven niet terug te vinden waren. */
  missing: string[]
  /** Opgeruimde verborgen systeembestanden van macOS/Windows. */
  junkRemoved: number
}

/** Uitkomst van de controle vooraf: mag er naar deze stick geschreven worden? */
export interface DriveCheck {
  level: 'ok' | 'warn' | 'block'
  /** Korte kop in mensentaal. */
  title: string
  /** Wat er aan de hand is. */
  message: string
  /** Wat de gebruiker moet doen. Leeg als er niets te doen valt. */
  fix: string
}

export interface EjectResult {
  ok: boolean
  /** Altijd ingevuld: wat de gebruiker nu wel of juist niet mag doen. */
  message: string
}

export interface DriveInfo {
  path: string
  label: string
  filesystem: string
  totalBytes: number
  freeBytes: number
  removable: boolean
}

export interface Settings {
  /** Eenvoudige modus: één scherm dat stap voor stap leidt. Standaard aan. */
  simpleMode: boolean
  outputDir: string
  naming: string
  concurrency: number
  audio: AudioSettings
  usb: {
    layout: ExportLayout
    asciiNames: boolean
    createM3u: boolean
  }
  /** Browser om cookies uit te lezen voor leeftijdscheck / members-only. Leeg = uit. */
  cookiesFromBrowser: string
  proxy: string
  keepSource: boolean
}

export interface LibraryItem {
  path: string
  name: string
  size: number
  mtime: number
  meta: Partial<TrackMeta>
  duration: number
}

export type UpdateState =
  | 'idle'
  | 'uit'
  | 'zoeken'
  | 'actueel'
  | 'beschikbaar'
  | 'downloaden'
  | 'gereed'
  | 'fout'

export interface UpdateStatus {
  state: UpdateState
  version: string
  notes: string
  progress: number
  error: string
}

export interface LicenceInfo {
  id: string
  name: string
  email: string
  issued: string
  /** Leeg = onbeperkt geldig. */
  expires: string
}

export interface LicenceStatus {
  valid: boolean
  reason: string
  info: LicenceInfo | null
}

export interface BinaryInfo {
  path: string
  ok: boolean
  version: string
  /** Leeg als het onderdeel werkt; anders in mensentaal waarom niet. */
  error: string
}

export interface BinaryStatus {
  ffmpeg: BinaryInfo
  ffprobe: BinaryInfo
  ytdlp: BinaryInfo
}
