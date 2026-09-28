import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
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
