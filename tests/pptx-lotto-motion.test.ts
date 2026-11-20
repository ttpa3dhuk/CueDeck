import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { preparePptxMedia } from '../src/main/pptx-media'

const source = process.env.CUEDECK_LOTTO_PPTX ?? ''

describe.skipIf(!existsSync(source))('Lotto authored object effects, parser only', () => {
  it.each(['powerpoint', 'libreoffice'] as const)('keeps button pulse and two automatic wobble chains for %s', async renderer => {
    const dir = await mkdtemp(join(tmpdir(), `cuedeck-lotto-motion-${renderer}-`))
    try {
      const prepared = await preparePptxMedia(source, `lotto-motion-${renderer}`,
        { writeDir: dir, readDir: () => dir, pdfPath: sha => join(dir, `${sha}.pdf`) }, renderer)
      const button = prepared.slideMedia.find(media => media.slide === 2 && media.interactive)?.interactive
      const wobble = prepared.slideMedia.find(media => media.slide === 35 && media.interactive)?.interactive
      expect(button?.triggers).toHaveLength(1)
      expect(button?.triggers[0].effects[0]).toMatchObject({ shape: '3', durationMs: 500,
        opacityFrames: [{ timeMs: 0, value: 1 }, { timeMs: 100, value: .5 },
          { timeMs: 400, value: .5 }, { timeMs: 500, value: 1 }],
        scaleFrames: [{ timeMs: 0, value: 1 }, { timeMs: 250, value: 1.05 }, { timeMs: 500, value: 1 }] })
      expect(wobble?.triggers).toEqual([])
      expect(wobble?.autoEffects).toHaveLength(2)
      expect(wobble?.autoEffects?.map(effect => effect.shape)).toEqual(['5', '10'])
      expect(wobble?.autoEffects?.every(effect => effect.durationMs === 2000 && effect.rotations?.at(-1)?.degrees === 0)).toBe(true)
      expect(prepared.nativeFrameSources?.some(asset => asset.file === 'video-foreground.pdf')).toBe(true)
      const frames = prepared.nativeFrameSources!.find(asset => asset.file === 'video-foreground.pdf')!.sourcePath
      const page = (n: number): string => execFileSync('unzip', ['-p', frames, `ppt/slides/_cuedeck_frame_${n}.xml`], { encoding: 'utf8' })
      const base = page(wobble!.firstPage - 1)
      const firstActor = page(wobble!.layers[0].page - 1)
      const secondActor = page(wobble!.layers[1].page - 1)
      expect(base).not.toMatch(/<p:cNvPr id="(?:5|10)"/)
      expect(firstActor).toMatch(/<p:cNvPr id="5"/)
      expect(firstActor).not.toMatch(/<p:cNvPr id="10"/)
      expect(secondActor).toMatch(/<p:cNvPr id="10"/)
      expect(secondActor).not.toMatch(/<p:cNvPr id="5"/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
