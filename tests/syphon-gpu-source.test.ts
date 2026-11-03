import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const runtimeFiles = [
  'src/main/syphon-gpu-publisher.ts',
  'src/main/syphon-gpu-audience.ts',
  'src/main/syphon-gpu-probe.ts',
  'src/main/syphon-gpu-native.ts',
]

describe('GPU runtime source has no CPU pixel path', () => {
  it('contains no bitmap/page/readback calls in the real and probe GPU runtime', () => {
    for (const file of runtimeFiles) {
      const source = readFileSync(file, 'utf8')
      for (const forbidden of ['toBitmap', 'getBitmap', 'capturePage', 'getBytes', 'replaceRegion']) {
        expect(source, `${file} must not use ${forbidden}`).not.toContain(forbidden)
      }
      if (file !== 'src/main/syphon-gpu-probe.ts') {
        expect(source, `${file} must not load the test canvas`).not.toContain('gpu-test/index.html')
      }
    }
    expect(readFileSync('src/main/syphon-gpu-probe.ts', 'utf8')).toContain('gpu-test/index.html')
  })
})

describe('GPU audience arbitration', () => {
  it('stream and OMT program release GPU before taking a normal audience renderer', () => {
    expect(readFileSync('src/main/stream/streamer.ts', 'utf8'))
      .toContain("stopGpuAudienceForNormalOutput('stream')")
    expect(readFileSync('src/main/omt/outputs.ts', 'utf8'))
      .toContain("stopGpuAudienceForNormalOutput('omt')")
    expect(readFileSync('src/main/windows.ts', 'utf8'))
      .toContain("entry: 'gpu-view', role: 'audience-gpu-view'")
    expect(readFileSync('src/main/syphon-gpu-audience.ts', 'utf8'))
      .toContain('createGpuAudienceWindow')
    expect(readFileSync('src/main/syphon-gpu-audience.ts', 'utf8'))
      .not.toContain('createHiddenAudienceWindow')
  })
})
