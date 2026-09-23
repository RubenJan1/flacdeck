import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { encodeFlac, prepareCover } from './audio'
import { applyTemplate } from './naming'
import { CancelledError, downloadAudio, downloadThumbnail } from './ytdlp'
import type { Job, JobRequest, Settings } from '../../shared/types'

interface Batch {
  id: string
  req: JobRequest
  settings: Settings
  workDir: string
  coverPath: string | null
  /** De bron wordt één keer opgehaald en door alle segmenten gedeeld. */
  sourcePromise: Promise<string> | null
  /**
   * Eigen controller voor die gedeelde download. Hing die aan de job die hem
   * toevallig als eerste startte, dan sloopte het annuleren van dat ene nummer
   * de download voor de hele lijst.
   */
  sourceController: AbortController
  sourceDuration: number
  remaining: number
}

export class JobQueue extends EventEmitter {
  private jobs = new Map<string, Job>()
  private batches = new Map<string, Batch>()
  private controllers = new Map<string, AbortController>()
  private pending: string[] = []
  private running = 0
  private limit = 2
  private takenNames = new Set<string>()

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  private emitJob(job: Job): void {
    this.jobs.set(job.id, job)
    this.emit('job', { ...job })
  }

  private patch(id: string, patch: Partial<Job>): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.emitJob({ ...job, ...patch })
  }

  /** Maakt jobs aan voor elk ingeschakeld segment en start ze. */
  async add(req: JobRequest, settings: Settings, sourceDuration: number): Promise<string[]> {
    const batchId = randomUUID()
    const segments = req.segments.filter((s) => s.enabled)
    if (!segments.length) throw new Error('Geen segmenten geselecteerd')
    this.limit = Math.max(1, Math.min(6, settings.concurrency || 2))

    const batch: Batch = {
      id: batchId,
      req,
      settings,
      workDir: path.join(app.getPath('userData'), 'cache', batchId),
      coverPath: null,
      sourcePromise: null,
      sourceController: new AbortController(),
      sourceDuration,
      remaining: segments.length
    }
    this.batches.set(batchId, batch)

    const ids: string[] = []
    for (const seg of segments) {
      const id = randomUUID()
      ids.push(id)
      this.emitJob({
        id,
        batchId,
        url: req.url,
        sourceTitle: req.sourceTitle,
        status: 'wachtrij',
        stage: 'in de wachtrij',
        progress: 0,
        error: null,
        outputPath: null,
        fileSize: null,
        meta: seg.meta,
        start: seg.start,
        end: seg.end,
        createdAt: Date.now() + ids.length,
        finishedAt: null
      })
      this.pending.push(id)
    }

    this.drain()
    return ids
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    if (job.status === 'klaar' || job.status === 'fout' || job.status === 'geannuleerd') return
    this.controllers.get(id)?.abort()
    this.pending = this.pending.filter((p) => p !== id)
    this.patch(id, { status: 'geannuleerd', stage: 'geannuleerd', finishedAt: Date.now() })
    this.stopSourceIfIdle(job.batchId)
  }

  /** De gedeelde download pas afbreken als er niemand meer op wacht. */
  private stopSourceIfIdle(batchId: string): void {
    const batch = this.batches.get(batchId)
    if (!batch) return
    const stillWanted = [...this.jobs.values()].some(
      (j) =>
        j.batchId === batchId &&
        (j.status === 'wachtrij' || j.status === 'ophalen' || j.status === 'downloaden' || j.status === 'knippen')
    )
    if (!stillWanted) batch.sourceController.abort()
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) this.cancel(job.id)
  }

  clearFinished(): void {
    for (const [id, job] of [...this.jobs.entries()]) {
      if (job.status === 'klaar' || job.status === 'fout' || job.status === 'geannuleerd') {
        this.jobs.delete(id)
        this.emit('removed', id)
      }
    }
    // Batches die alleen nog opgeruimde jobs hadden, hielden hun werkmap vast.
    for (const [batchId, batch] of [...this.batches.entries()]) {
      if ([...this.jobs.values()].some((j) => j.batchId === batchId)) continue
      batch.sourceController.abort()
      void fsp.rm(batch.workDir, { recursive: true, force: true }).catch(() => undefined)
      this.batches.delete(batchId)
    }
  }

  retry(id: string): void {
    const job = this.jobs.get(id)
    if (!job || job.status === 'wachtrij') return
    const batch = this.batches.get(job.batchId)
    if (!batch) {
      this.patch(id, { status: 'fout', error: 'Bron niet meer beschikbaar, voeg de link opnieuw toe.' })
      return
    }
    // Een afgebroken download liet een afgewezen promise achter; wie daar op
    // bleef wachten kreeg bij elke poging opnieuw dezelfde fout te zien.
    if (batch.sourceController.signal.aborted) {
      batch.sourceController = new AbortController()
      batch.sourcePromise = null
    }
    batch.remaining += 1
    this.patch(id, { status: 'wachtrij', stage: 'in de wachtrij', progress: 0, error: null, finishedAt: null })
    this.pending.push(id)
    this.drain()
  }

  private drain(): void {
    while (this.running < this.limit && this.pending.length) {
      const id = this.pending.shift() as string
      const job = this.jobs.get(id)
      if (!job || job.status === 'geannuleerd') continue
      this.running += 1
      void this.execute(id).finally(() => {
        this.running -= 1
        this.drain()
      })
    }
  }

  /** Downloadt de bron één keer per batch en deelt hem tussen de segmenten. */
  private source(batch: Batch): Promise<string> {
    if (!batch.sourcePromise) {
      batch.sourcePromise = downloadAudio({
        url: batch.req.url,
        outDir: batch.workDir,
        outBase: 'source',
        isLive: batch.req.isLive,
        settings: batch.settings,
        onProgress: (pct) => this.broadcastBatch(batch.id, pct),
        signal: batch.sourceController.signal
      }).catch((err: unknown) => {
        // Niet de afgewezen promise bewaren: anders faalt elk volgend nummer en
        // elke poging tot opnieuw proberen meteen met dezelfde oude fout.
        batch.sourcePromise = null
        throw err
      })
    }
    return batch.sourcePromise
  }

  /** Downloadvoortgang van de gedeelde bron geldt voor alle wachtende jobs. */
  private broadcastBatch(batchId: string, pct: number): void {
    for (const job of this.jobs.values()) {
      if (job.batchId !== batchId) continue
      if (job.status !== 'downloaden' && job.status !== 'wachtrij') continue
      this.emitJob({ ...job, status: 'downloaden', stage: 'bron downloaden', progress: Math.round(pct * 0.6) })
    }
  }

  private async cover(batch: Batch, controller: AbortController): Promise<string | null> {
    if (batch.coverPath !== null) return batch.coverPath || null
    const { req } = batch
    try {
      if (req.coverMode === 'none') {
        batch.coverPath = ''
        return null
      }
      let raw = req.coverFile
      if (req.coverMode === 'video') {
        if (!req.coverUrl) {
          batch.coverPath = ''
          return null
        }
        raw = await downloadThumbnail(req.coverUrl, path.join(batch.workDir, 'thumb.img'))
      }
      if (!raw) {
        batch.coverPath = ''
        return null
      }
      if (controller.signal.aborted) throw new CancelledError()
      batch.coverPath = await prepareCover(raw, path.join(batch.workDir, 'cover.jpg'), req.squareCover)
      return batch.coverPath
    } catch {
      // Zonder cover is de track nog steeds prima; niet de hele job laten klappen.
      batch.coverPath = ''
      return null
    }
  }

  private outputPath(job: Job, settings: Settings): string {
    const base = path.join(settings.outputDir, applyTemplate(settings.naming, job.meta, { maxLength: 100 }))
    // Bestaande bestanden op schijf tellen mee, anders overschrijft een tweede
    // sessie stilletjes wat er al staat.
    let candidate = base + '.flac'
    let n = 2
    while (this.takenNames.has(candidate.toLowerCase()) || existsSync(candidate)) {
      candidate = base + ' (' + n + ').flac'
      n += 1
    }
    this.takenNames.add(candidate.toLowerCase())
    return candidate
  }

  private async execute(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job) return
    const batch = this.batches.get(job.batchId)
    if (!batch) {
      this.patch(id, { status: 'fout', error: 'Bron niet meer beschikbaar', finishedAt: Date.now() })
      return
    }

    const controller = new AbortController()
    this.controllers.set(id, controller)

    try {
      this.patch(id, { status: 'ophalen', stage: 'voorbereiden', progress: 2 })
      await fsp.mkdir(batch.workDir, { recursive: true })
      const coverPath = await this.cover(batch, controller)

      this.patch(id, { status: 'downloaden', stage: 'bron downloaden', progress: 5 })
      const input = await this.source(batch)

      if (controller.signal.aborted) throw new CancelledError()

      this.patch(id, { status: 'knippen', stage: 'omzetten naar FLAC', progress: 62 })
      const output = this.outputPath(job, batch.settings)

      const encoded = await encodeFlac({
        input,
        output,
        start: job.start,
        end: job.end,
        meta: job.meta,
        cover: coverPath,
        audio: batch.settings.audio,
        onProgress: (pct) =>
          this.patch(id, { status: 'knippen', stage: 'omzetten naar FLAC', progress: 62 + Math.round(pct * 0.36) }),
        signal: controller.signal
      })

      this.patch(id, {
        status: 'klaar',
        stage: 'klaar',
        progress: 100,
        outputPath: encoded.path,
        fileSize: encoded.size,
        finishedAt: Date.now()
      })
    } catch (err) {
      const cancelled = err instanceof CancelledError || controller.signal.aborted
      this.patch(id, {
        status: cancelled ? 'geannuleerd' : 'fout',
        stage: cancelled ? 'geannuleerd' : 'mislukt',
        error: cancelled ? null : (err as Error).message,
        finishedAt: Date.now()
      })
    } finally {
      this.controllers.delete(id)
      batch.remaining -= 1
      if (batch.remaining <= 0) {
        // Is er iets misgegaan, dan blijft de batch staan zodat "opnieuw
        // proberen" de bron nog kan gebruiken in plaats van te melden dat hij
        // weg is. Pas bij het legen van de lijst gaat hij echt weg.
        const recoverable = [...this.jobs.values()].some(
          (j) => j.batchId === batch.id && (j.status === 'fout' || j.status === 'geannuleerd')
        )
        if (!recoverable) {
          if (!batch.settings.keepSource) {
            await fsp.rm(batch.workDir, { recursive: true, force: true }).catch(() => undefined)
          }
          this.batches.delete(batch.id)
          this.emit('batchDone', batch.id)
        }
      }
    }
  }
}

export const queue = new JobQueue()
