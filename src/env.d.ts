/// <reference types="vite/client" />

import type { FlacDeckApi } from '../electron/preload'

declare global {
  interface Window {
    api: FlacDeckApi
  }
}

export {}
