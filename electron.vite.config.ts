import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'electron/main.ts') } }
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'shared') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'electron/preload.ts') } }
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'shared') } }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/index.html') } }
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'shared') } },
    plugins: [react()]
  }
})
