import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        // Нативный модуль (FFI к libomt) — не бандлится, грузится из node_modules.
        external: ['koffi'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          presenter: resolve(__dirname, 'src/renderer/presenter/index.html'),
          audience: resolve(__dirname, 'src/renderer/audience/index.html'),
          stream: resolve(__dirname, 'src/renderer/stream/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          'omt-audio': resolve(__dirname, 'src/renderer/omt-audio/index.html'),
        },
      },
    },
    server: {
      fs: {
        allow: [resolve(__dirname)],
      },
    },
  },
})
