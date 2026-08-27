import os from 'node:os'
import path from 'node:path'

const base = path.join(os.tmpdir(), 'flacdeck-test')

/** Minimale vervanging voor de electron-module zodat services buiten de app draaien. */
export const app = {
  getPath: (name: string): string => path.join(base, name),
  getVersion: (): string => '0.0.0-test'
}

export default { app }
