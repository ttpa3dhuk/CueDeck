import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const LIB = resolve('native/syphon-probe/build/libcuedeck_syphon_gpu.dylib')
const suite = existsSync(LIB) ? describe : describe.skip

suite('Koffi -> in-process GPU C ABI', () => {
  it('runs the non-global IOSurface selftest through Koffi in both Y modes', () => {
    const koffi = createRequire(import.meta.url)('koffi')
    const lib = koffi.load(LIB)
    const selftest = lib.func('int cuedeck_gpu_selftest(int)')
    expect(Number(selftest(0))).toBe(0)
    expect(Number(selftest(1))).toBe(0)
  }, 20000)
})
