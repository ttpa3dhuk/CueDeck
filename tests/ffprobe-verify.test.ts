import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const REAL_VENDOR = join(ROOT, 'vendor', 'ffprobe')
const SCRIPT = join(ROOT, 'scripts', 'prepare-ffprobe.cjs')
const available = existsSync(join(REAL_VENDOR, 'manifest.json')) && existsSync(join(REAL_VENDOR, 'win-x64', 'ffprobe.exe'))
const tempDirs: string[] = []

function sha(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function fixtureVendor(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cuedeck-ffprobe-'))
  tempDirs.push(dir)
  const vendor = join(dir, 'vendor', 'ffprobe')
  cpSync(REAL_VENDOR, vendor, {
    recursive: true,
    filter: (source) => !source.includes('/.build') && (!source.includes('/mac-') || source.endsWith('manifest.json')),
  })
  // win-x64 is enough for a read-only manifest test; keep the full manifest.
  return vendor
}

function verify(vendor: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT, '--verify-only', '--target=win32-x64', `--vendor=${vendor}`], {
    cwd: ROOT, encoding: 'utf8',
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!available)('strict ffprobe verify-only gate', () => {
  it('passes on shipped resources and does not rewrite the manifest', () => {
    const vendor = fixtureVendor()
    const manifest = join(vendor, 'manifest.json')
    const before = sha(manifest)
    const result = verify(vendor)
    expect(result.status, String(result.stderr)).toBe(0)
    expect(String(result.stdout)).toContain('read-only')
    expect(sha(manifest)).toBe(before)
  })

  it('fails when a binary byte changes after the manifest was generated', () => {
    const vendor = fixtureVendor()
    appendFileSync(join(vendor, 'win-x64', 'ffprobe.exe'), Buffer.from([0]))
    const result = verify(vendor)
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toContain('manifest SHA mismatch')
  })

  it('fails when the corresponding source archive is corrupt', () => {
    const vendor = fixtureVendor()
    const manifest = join(vendor, 'manifest.json')
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    const archive = join(vendor, parsed['win32-x64'].sourceArchive)
    appendFileSync(archive, Buffer.from([0]))
    const result = verify(vendor)
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toMatch(/source archive SHA mismatch|source archive SHA/)
  })

  it('fails closed when the manifest is missing', () => {
    const vendor = fixtureVendor()
    rmSync(join(vendor, 'manifest.json'))
    const result = verify(vendor)
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toContain('manifest')
  })
})
