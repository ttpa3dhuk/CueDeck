import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { expect, it, vi } from 'vitest'

const userData = join(tmpdir(), `cuedeck-preparation-baseline-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
import { preparePptxMedia } from '../src/main/pptx-media'

/** Opt in: real private decks, never required by public CI or ordinary unit runs. */
it.skipIf(process.env.CUEDECK_CORPUS_BASELINE !== '1')('records the existing main-thread PPTX work on private originals', async () => {
  const corpus = join(process.cwd(), 'resources/private-regression')
  const manifest = JSON.parse(await readFile(join(corpus, 'manifest.json'), 'utf8'))
  const results = []
  await mkdir(userData, { recursive: true })
  try {
    for (const entry of manifest.files) {
      if (!entry.file) continue
      const path = join(corpus, entry.file)
      const before = createHash('sha256').update(await readFile(path)).digest('hex')
      expect(before).toBe(entry.sha256)
      const delay = monitorEventLoopDelay({ resolution: 10 })
      delay.enable()
      await new Promise(resolve => setTimeout(resolve, 30))
      const start = performance.now()
      const bytes = await readFile(path)
      const sha1 = createHash('sha1').update(bytes).digest('hex')
      const prepared = await preparePptxMedia(path, sha1)
      const workMs = performance.now() - start
      await new Promise(resolve => setTimeout(resolve, 30))
      delay.disable()
      const after = createHash('sha256').update(await readFile(path)).digest('hex')
      expect(after).toBe(before)
      results.push({ file: entry.file, bytes: entry.bytes, sha1, sha256: before,
        workMs, eventLoopMaxMs: delay.max / 1e6, eventLoopP99Ms: delay.percentile(99) / 1e6,
        mediaCount: prepared.slideMedia.length, notesCount: Object.keys(prepared.pageNotes).length,
        slideMedia: prepared.slideMedia, pageNotes: prepared.pageNotes,
      })
    }
    await writeFile('generated/background-preparation-20261105/corpus-baseline.json', JSON.stringify({
      scope: 'Node/Vitest main-thread read/hash/OOXML extraction only; excludes LibreOffice, Electron UI and PDF rasterization',
      platform: process.platform, node: process.version, results,
    }, null, 2))
    expect(results).toHaveLength(3)
  } finally { await rm(userData, { recursive: true, force: true }) }
}, 120_000)
