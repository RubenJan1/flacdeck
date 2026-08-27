import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { LICENCE_PUBLIC_KEY } from '../../shared/licence-key'
import type { LicenceInfo, LicenceStatus } from '../../shared/types'

const PREFIX = 'FD1'

function fromB64url(str: string): Buffer {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'licentie.txt')
}

interface Payload {
  v?: number
  id?: string
  n?: string
  e?: string
  iat?: string
  exp?: string
}

/**
 * Controleert een sleutel tegen de ingebakken publieke sleutel.
 *
 * Dit is een drempel, geen kluis: wie de app uitpakt en aanpast, komt er
 * altijd langs. Wat het wél doet is voorkomen dat iemand zelf geldige
 * sleutels kan maken — daarvoor is de geheime sleutel nodig, en die heb
 * alleen jij.
 */
export function verifyKey(raw: string): LicenceStatus {
  const cleaned = String(raw ?? '').replace(/\s+/g, '')
  if (!cleaned) return { valid: false, reason: 'Vul een sleutel in.', info: null }

  const parts = cleaned.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return { valid: false, reason: 'Dit ziet er niet uit als een FlacDeck-sleutel.', info: null }
  }

  let payload: Payload
  try {
    payload = JSON.parse(fromB64url(parts[1]).toString('utf8')) as Payload
  } catch {
    return { valid: false, reason: 'De sleutel is beschadigd — kopieer hem opnieuw.', info: null }
  }

  let signatureOk = false
  try {
    signatureOk = crypto.verify(
      null,
      Buffer.from(PREFIX + '.' + parts[1]),
      crypto.createPublicKey(LICENCE_PUBLIC_KEY.trim() + '\n'),
      fromB64url(parts[2])
    )
  } catch {
    signatureOk = false
  }
  if (!signatureOk) {
    return { valid: false, reason: 'Deze sleutel is niet geldig.', info: null }
  }

  const info: LicenceInfo = {
    id: payload.id ?? '',
    name: payload.n ?? '',
    email: payload.e ?? '',
    issued: payload.iat ?? '',
    expires: payload.exp ?? ''
  }

  if (info.expires && info.expires < new Date().toISOString().slice(0, 10)) {
    return { valid: false, reason: 'Deze sleutel is verlopen op ' + info.expires + '.', info }
  }

  return { valid: true, reason: '', info }
}

/** Leest de opgeslagen sleutel en controleert die opnieuw bij elke start. */
export function currentStatus(): LicenceStatus {
  try {
    return verifyKey(fs.readFileSync(storePath(), 'utf8'))
  } catch {
    return { valid: false, reason: '', info: null }
  }
}

export function activate(raw: string): LicenceStatus {
  const status = verifyKey(raw)
  if (!status.valid) return status
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true })
    fs.writeFileSync(storePath(), String(raw).replace(/\s+/g, ''), 'utf8')
  } catch (err) {
    return { valid: false, reason: 'Opslaan mislukt: ' + (err as Error).message, info: null }
  }
  return status
}

export function deactivate(): void {
  try {
    fs.rmSync(storePath(), { force: true })
  } catch {
    /* al weg */
  }
}

/** Gooit als er geen geldige sleutel is. Beschermt de IPC-kant, niet alleen de UI. */
export function requireLicence(): void {
  if (!currentStatus().valid) {
    throw new Error('Geen geldige sleutel. Voer eerst je toegangssleutel in.')
  }
}
