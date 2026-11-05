import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  prepareStagedArtifacts,
  stageSourceCopy,
} from '../src/main/presentation-preparation-core'

/**
 * Opt-in реальный прогон без Electron/GUI:
 *
 *   CUEDECK_REAL_PPTX="/path/to/private/deck.pptx" \
 *   CUEDECK_SOFFICE="/Applications/LibreOffice.app/Contents/MacOS/soffice" \
 *   npx vitest run tests/presentation-preparation-real.test.ts
 *
 * Файл не копируется в git и не попадает в пользовательский кэш: вся работа
 * идёт в os.tmpdir(), soffice получает уникальный профиль в stage.
 */
const source = process.env.CUEDECK_REAL_PPTX
const soffice = process.env.CUEDECK_SOFFICE ?? [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/opt/homebrew/bin/soffice',
  '/usr/local/bin/soffice',
  '/usr/bin/soffice',
].find((path) => existsSync(path))

describe.skipIf(!source || !existsSync(source) || !soffice)('presentation preparation real LibreOffice smoke', () => {
  it('stages, hashes, converts and returns an integral PDF/manifest set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cuedeck-preparation-real-'))
    const stage = join(dir, 'stage')
    try {
      const staged = await stageSourceCopy(source!, stage)
      expect(staged.sha1).toMatch(/^[a-f0-9]{40}$/)
      const artifacts = await prepareStagedArtifacts({
        stagedPath: staged.stagedPath,
        originalPath: source!,
        sha1: staged.sha1,
        stageDir: stage,
        identityBefore: staged.identityBefore,
        sofficePath: soffice!,
        timeoutMs: Number(process.env.CUEDECK_REAL_TIMEOUT_MS ?? 10 * 60_000),
      })
      const pdf = await stat(join(artifacts.artifactsDir, `${staged.sha1}.pdf`))
      expect(pdf.size).toBeGreaterThan(0)
      expect(artifacts.totalSlides).toBeGreaterThanOrEqual(0)
      expect(artifacts.hasManifest).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
