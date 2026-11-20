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
 * CUEDECK_REAL_AUDIO=click проверяет звук по кнопке, =both ещё и автозапуск.
 * CUEDECK_REAL_BACKEND=powerpoint-static выбирает установленный PowerPoint.
 *
 * Файл не копируется в git и не попадает в пользовательский кэш: вся работа
 * идёт в os.tmpdir(), soffice получает уникальный профиль в stage.
 */
const source = process.env.CUEDECK_REAL_PPTX
const backend = process.env.CUEDECK_REAL_BACKEND === 'powerpoint-static' ? 'powerpoint-static' : 'libreoffice'
const soffice = process.env.CUEDECK_SOFFICE ?? [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/opt/homebrew/bin/soffice',
  '/usr/local/bin/soffice',
  '/usr/bin/soffice',
].find((path) => existsSync(path))

describe.skipIf(!source || !existsSync(source) || (backend === 'libreoffice' && !soffice))(`presentation preparation real ${backend} smoke`, () => {
  it('stages, hashes, converts and returns an integral PDF/manifest set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cuedeck-preparation-real-'))
    const stage = join(dir, 'jobs', 'stage')
    try {
      const staged = await stageSourceCopy(source!, stage)
      expect(staged.sha1).toMatch(/^[a-f0-9]{40}$/)
      const artifacts = await prepareStagedArtifacts({
        stagedPath: staged.stagedPath,
        originalPath: source!,
        sha1: staged.sha1,
        stageDir: stage,
        identityBefore: staged.identityBefore,
        backend,
        sofficePath: soffice ?? null,
        timeoutMs: Number(process.env.CUEDECK_REAL_TIMEOUT_MS ?? 10 * 60_000),
      })
      const pdf = await stat(join(artifacts.artifactsDir, `${staged.sha1}.pdf`))
      expect(pdf.size).toBeGreaterThan(0)
      expect(artifacts.totalSlides).toBeGreaterThanOrEqual(0)
      expect(artifacts.hasManifest).toBe(true)
      const audioMode = process.env.CUEDECK_REAL_AUDIO
      if (audioMode === 'click' || audioMode === 'both') {
        const cues = artifacts.slideMedia.flatMap(media => media.audio ?? [])
        if (audioMode === 'both') expect(cues.some(cue => cue.trigger === 'enter')).toBe(true)
        expect(cues.some(cue => cue.trigger === 'click')).toBe(true)
        expect(artifacts.slideMedia.some(media => media.clickActions?.length)).toBe(true)
        for (const file of new Set(cues.map(cue => cue.file))) {
          const audio = await stat(join(artifacts.artifactsDir, `${staged.sha1}.media`, file))
          expect(audio.size).toBeGreaterThan(0)
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
