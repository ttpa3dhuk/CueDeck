import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  build: {
    mac: { extraResources: Array<{ from: string; to: string }>; binaries?: string[] }
    win: { extraResources: Array<{ from: string; to: string }> }
  }
}
const script = readFileSync(join(ROOT, 'scripts/prepare-ffprobe.cjs'), 'utf8')
const resolver = readFileSync(join(ROOT, 'src/main/frame-timeline.ts'), 'utf8')

describe('bundled ffprobe packaging contract', () => {
  it('packages the matching arch outside ASAR and signs the Mac binary', () => {
    for (const platform of [pkg.build.mac, pkg.build.win]) {
      const resource = platform.extraResources.find((entry) => entry.to === 'ffprobe')
      expect(resource).toEqual({ from: 'vendor/ffprobe/${os}-${arch}', to: 'ffprobe' })
    }
    expect(pkg.build.mac.binaries).toContain('Contents/Resources/ffprobe/ffprobe')
    expect(resolver).toContain("join(resourcesPath, 'ffprobe'")
  })

  it('both packaging commands prepare and strictly verify before electron-builder', () => {
    expect(pkg.scripts['package:mac']).toContain('prepare-ffprobe.cjs --target=darwin-arm64,darwin-x64')
    expect(pkg.scripts['package:win']).toContain('prepare-ffprobe.cjs --target=win32-x64')
    expect(pkg.scripts['package:mac'].indexOf('prepare-ffprobe')).toBeLessThan(pkg.scripts['package:mac'].indexOf('electron-builder'))
    expect(pkg.scripts['package:win'].indexOf('prepare-ffprobe')).toBeLessThan(pkg.scripts['package:win'].indexOf('electron-builder'))
    expect(pkg.scripts['prepare:ffprobe']).toContain('--target=all')
    expect(pkg.scripts['verify:ffprobe']).toContain('--verify-only')
  })

  it('source build is pinned, LGPL-only and does not fetch GPL binaries', () => {
    expect(script).toContain('https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz')
    expect(script).toContain('8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e')
    expect(script).toContain('9.0.2')
    expect(script).toContain("'--disable-gpl'")
    expect(script).toContain("'--disable-nonfree'")
    expect(script).toContain("'--enable-ffprobe'")
    expect(script).toContain("'--enable-protocol=file'")
    expect(script).toContain('--enable-demuxer=mov,matroska')
    expect(script).toContain('wgQ/UNoVbb4gf9zEbmN596Hk3OS0TnhS5mo9ety8oE0fZo+lompDj9It/icIUhkqhXvjJ2FAusB0/TwZk43fhA==')
    expect(script).not.toContain('ffmpeg-static')
    expect(script).not.toContain('@ffprobe-installer')
  })

  it('vendor binaries and build caches stay out of git', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    expect(gitignore.split(/\r?\n/)).toContain('vendor/')
  })
})
