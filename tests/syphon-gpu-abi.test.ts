import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const PROBE = resolve('native/syphon-probe/build/CueDeckGpuAbiProbe')
const suite = existsSync(PROBE) ? describe : describe.skip

suite('native in-process GPU ABI positive control', () => {
  it('publishes a non-global IOSurface through async Metal completion, both Y modes', async () => {
    for (const flip of ['0', '1']) {
      const result = await execFileAsync(PROBE, ['--flip-y', flip], { timeout: 15000 })
      expect(result.stdout).toContain('GPU-ABI-SELFTEST PASS')
      expect(result.stdout).toContain('non-global IOSurface')
      expect(result.stdout).toContain(`flipY=${flip}`)
    }
  })
})
