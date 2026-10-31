#!/usr/bin/env node
/*
 * Build the small LGPL ffprobe used for frame stepping, or verify the copies
 * already built under vendor/ffprobe. No npm runtime dependency is added.
 *
 * Source: FFmpeg 9.0.2 (LGPL-2.1-or-later, no --enable-gpl/--enable-nonfree).
 * Toolchain: Apple clang for macOS; Zig's bundled x86_64-windows-gnu target for
 * Windows x64. Zig archive is the npm mirror pinned below (SHA-512 verified).
 *
 * All downloads/builds are bounded and cached under vendor/ffprobe/.build.
 * Binaries and caches stay untracked (vendor/ is ignored).
 */
'use strict'

const { spawn, execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const vendorArg = (() => {
  const inline = process.argv.find((value) => value.startsWith('--vendor='))
  if (inline !== undefined) return inline.slice('--vendor='.length)
  const at = process.argv.indexOf('--vendor')
  return at >= 0 ? process.argv[at + 1] : undefined
})()
const VENDOR = path.resolve(vendorArg || process.env.CUEDECK_FFPROBE_VENDOR || path.join(ROOT, 'vendor', 'ffprobe'))
const BUILD = path.join(VENDOR, '.build')
const CACHE = path.join(BUILD, 'cache')
const SOURCE_DIR = path.join(BUILD, 'ffmpeg-src')
const ZIG_DIR = path.join(BUILD, 'zig')
const ZIG_CACHE = path.join(BUILD, 'zig-cache')

const FFMPEG_VERSION = '9.0.2'
const FFMPEG_URL = `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`
const FFMPEG_SHA256 = '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e'
const SOURCE_ARCHIVE_NAME = `ffmpeg-${FFMPEG_VERSION}.tar.xz`
const FFMPEG_SOURCE_TAR = path.join(CACHE, SOURCE_ARCHIVE_NAME)

const ZIG_URL = 'https://registry.npmjs.org/@ryoppippi/zig-darwin-arm64/-/zig-darwin-arm64-0.14.0-dev.2456.tgz'
const ZIG_SHA512 = 'wgQ/UNoVbb4gf9zEbmN596Hk3OS0TnhS5mo9ety8oE0fZo+lompDj9It/icIUhkqhXvjJ2FAusB0/TwZk43fhA=='
const ZIG_TAR = path.join(CACHE, 'zig-toolchain.tgz')

const COMMON = [
  '--disable-everything',
  '--disable-autodetect',
  '--disable-gpl',
  '--disable-nonfree',
  '--disable-programs',
  '--enable-ffprobe',
  '--disable-doc',
  '--disable-asm',
  '--disable-avdevice',
  '--disable-avfilter',
  '--disable-swscale',
  '--disable-swresample',
  '--disable-network',
  '--enable-protocol=file',
  '--enable-demuxer=mov,matroska',
  '--enable-parser=h264,hevc,vp8,vp9,mpeg4video,av1',
  '--enable-decoder=h264,hevc,vp8,vp9,mpeg4,av1',
]

const TARGETS = {
  'darwin-arm64': { dir: 'mac-arm64', platform: 'darwin', arch: 'arm64', exe: 'ffprobe' },
  'darwin-x64': { dir: 'mac-x64', platform: 'darwin', arch: 'x64', exe: 'ffprobe' },
  'win32-x64': { dir: 'win-x64', platform: 'win32', arch: 'x64', exe: 'ffprobe.exe' },
}

function arg(name) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}
function has(name) { return process.argv.includes(name) }
const verifyOnly = has('--verify-only')
const metadataOnly = has('--metadata-only')
const jobs = Math.max(1, Math.min(16, Number(arg('--jobs') || os.cpus().length || 4)))
const targetArg = arg('--target') || 'all'
const selected = targetArg === 'all'
  ? Object.keys(TARGETS)
  : targetArg.split(',').map((name) => name.trim()).filter(Boolean)
for (const name of selected) {
  if (!TARGETS[name]) throw new Error(`unknown target: ${name}`)
}

function log(message) { console.log(`[ffprobe] ${message}`) }
function sha(file, algorithm) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('hex')
}
function sha512base64(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')
}
async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }) }

async function run(command, args, { cwd, env, timeoutMs, logPath }) {
  await ensureDir(path.dirname(logPath))
  const stream = fs.createWriteStream(logPath, { flags: 'a' })
  stream.write(`$ ${command} ${args.join(' ')}\n`)
  const child = spawn(command, args, {
    cwd, env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  child.stdout.pipe(stream)
  child.stderr.pipe(stream)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch { /* already gone */ }
  }, timeoutMs)
  try {
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    if (timedOut) throw new Error(`${command} timed out after ${timeoutMs} ms (see ${logPath})`)
    if (code !== 0) throw new Error(`${command} exited ${code} (see ${logPath})`)
  } finally {
    clearTimeout(timer)
    stream.end()
  }
}

function capture(command, args, timeoutMs = 30000) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function download(url, dest, timeoutMs) {
  await ensureDir(path.dirname(dest))
  log(`download ${url}`)
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('empty download')
  const tmp = `${dest}.part-${process.pid}`
  await fsp.writeFile(tmp, bytes)
  await fsp.rename(tmp, dest)
}

async function ensureSource() {
  await ensureDir(CACHE)
  if (fs.existsSync(FFMPEG_SOURCE_TAR)) {
    const actual = sha(FFMPEG_SOURCE_TAR, 'sha256')
    if (actual !== FFMPEG_SHA256) throw new Error(`FFmpeg source hash mismatch: ${actual}`)
  } else {
    await download(FFMPEG_URL, FFMPEG_SOURCE_TAR, 180_000)
    const actual = sha(FFMPEG_SOURCE_TAR, 'sha256')
    if (actual !== FFMPEG_SHA256) throw new Error(`FFmpeg source hash mismatch: ${actual}`)
  }
  const marker = path.join(SOURCE_DIR, '.ffmpeg-version')
  if (fs.existsSync(marker) && (await fsp.readFile(marker, 'utf8')).trim() === FFMPEG_VERSION) return
  await fsp.rm(SOURCE_DIR, { recursive: true, force: true })
  await ensureDir(SOURCE_DIR)
  log(`extract FFmpeg ${FFMPEG_VERSION}`)
  await run('tar', ['-xJf', FFMPEG_SOURCE_TAR, '-C', SOURCE_DIR, '--strip-components=1'], {
    timeoutMs: 180_000, logPath: path.join(BUILD, 'source-extract.log'),
  })
  await fsp.writeFile(marker, `${FFMPEG_VERSION}\n`)
}

async function ensureZig() {
  const explicit = arg('--zig') || process.env.CUEDECK_ZIG
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`Zig not found: ${explicit}`)
    return explicit
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Windows cross-build needs darwin-arm64 host or --zig=<path>')
  }
  await ensureDir(CACHE)
  if (!fs.existsSync(ZIG_TAR)) await download(ZIG_URL, ZIG_TAR, 180_000)
  const actual = sha512base64(ZIG_TAR)
  if (actual !== ZIG_SHA512) throw new Error(`Zig toolchain SHA-512 mismatch: ${actual}`)
  const zig = path.join(ZIG_DIR, 'package', 'zig')
  if (!fs.existsSync(zig)) {
    await fsp.rm(ZIG_DIR, { recursive: true, force: true })
    await ensureDir(ZIG_DIR)
    log('extract pinned Zig toolchain')
    await run('tar', ['-xzf', ZIG_TAR, '-C', ZIG_DIR], {
      timeoutMs: 180_000, logPath: path.join(BUILD, 'zig-extract.log'),
    })
  }
  await fsp.chmod(zig, 0o755)
  return zig
}

async function cleanSource() {
  await run('make', ['distclean'], {
    cwd: SOURCE_DIR, timeoutMs: 120_000, logPath: path.join(BUILD, 'distclean.log'),
  }).catch(() => undefined)
}

async function buildMac(target) {
  const clang = capture('xcrun', ['--find', 'clang'])
  const sdk = capture('xcrun', ['--show-sdk-path'])
  const arch = target.arch === 'arm64' ? 'arm64' : 'x86_64'
  const native = process.platform === 'darwin' && process.arch === target.arch
  const out = path.join(VENDOR, target.dir)
  await cleanSource()
  const configure = [
    `--prefix=${path.join(BUILD, `install-${target.dir}`)}`,
    `--arch=${arch}`,
    ...(native ? [] : ['--target-os=darwin']),
    `--cc=${native ? `${clang} -isysroot ${sdk}` : `${clang} -arch ${arch} -isysroot ${sdk}`}`,
    '--disable-debug',
    ...COMMON,
  ]
  log(`configure ${target.dir}`)
  await run('./configure', configure, {
    cwd: SOURCE_DIR, timeoutMs: 180_000, logPath: path.join(BUILD, `${target.dir}.configure.log`),
  })
  log(`make ${target.dir}`)
  await run('make', [`-j${jobs}`, 'ffprobe'], {
    cwd: SOURCE_DIR, timeoutMs: 20 * 60_000, logPath: path.join(BUILD, `${target.dir}.build.log`),
  })
  const built = path.join(SOURCE_DIR, 'ffprobe')
  await ensureDir(out)
  await fsp.copyFile(built, path.join(out, target.exe))
  await fsp.chmod(path.join(out, target.exe), 0o755)
  await deliverMetadata(target, out, `Apple clang (${clang}), -arch ${arch}`)
}

async function writeWrapper(name, body) {
  const file = path.join(BUILD, name)
  await fsp.writeFile(file, body, 'utf8')
  await fsp.chmod(file, 0o755)
  return file
}

async function buildWindows(target) {
  const zig = await ensureZig()
  const llvmNm = (() => {
    try { return capture('xcrun', ['--find', 'llvm-nm']) } catch { /* fall through */ }
    const fallback = '/Library/Developer/CommandLineTools/usr/bin/llvm-nm'
    if (fs.existsSync(fallback)) return fallback
    throw new Error('llvm-nm not found (Xcode Command Line Tools required for Zig PE build)')
  })()
  const zigDir = path.dirname(zig)
  const cc = await writeWrapper(`${target.dir}-cc`, `#!/bin/sh
export ZIG_GLOBAL_CACHE_DIR="${ZIG_CACHE}/global"
export ZIG_LOCAL_CACHE_DIR="${ZIG_CACHE}/local"
export TMPDIR="${BUILD}/tmp"
mkdir -p "$ZIG_GLOBAL_CACHE_DIR" "$ZIG_LOCAL_CACHE_DIR" "$TMPDIR"
exec "${zig}" cc -target x86_64-windows-gnu "$@"
`)
  const ar = await writeWrapper(`${target.dir}-ar`, `#!/bin/sh
exec "${zig}" ar "$@"
`)
  await ensureDir(path.join(BUILD, 'tmp'))
  const out = path.join(VENDOR, target.dir)
  await cleanSource()
  const configure = [
    `--prefix=${path.join(BUILD, `install-${target.dir}`)}`,
    '--target-os=mingw32',
    '--enable-cross-compile',
    '--arch=x86_64',
    `--cc=${cc}`,
    `--ar=${ar}`,
    `--nm=${llvmNm}`,
    '--disable-stripping',
    '--enable-debug=0',
    ...COMMON,
  ]
  log(`configure ${target.dir}`)
  await run('./configure', configure, {
    cwd: SOURCE_DIR, timeoutMs: 180_000, logPath: path.join(BUILD, `${target.dir}.configure.log`),
  })
  log(`make ${target.dir}`)
  await run('make', [`-j${jobs}`, 'ffprobe.exe'], {
    cwd: SOURCE_DIR, timeoutMs: 20 * 60_000, logPath: path.join(BUILD, `${target.dir}.build.log`),
  })
  const built = path.join(SOURCE_DIR, 'ffprobe.exe')
  await ensureDir(out)
  await fsp.copyFile(built, path.join(out, target.exe))
  await fsp.chmod(path.join(out, target.exe), 0o755)
  await deliverMetadata(target, out, `Zig ${capture(zig, ['version'])} --target x86_64-windows-gnu; llvm-nm ${llvmNm}`)
}

async function deliverMetadata(target, out, toolchain) {
  await fsp.copyFile(path.join(SOURCE_DIR, 'COPYING.LGPLv2.1'), path.join(out, 'LICENSE'))
  await fsp.copyFile(path.join(SOURCE_DIR, 'LICENSE.md'), path.join(out, 'LICENSE.md'))
  // Corresponding source must travel with the binary, not just a URL.
  await fsp.copyFile(FFMPEG_SOURCE_TAR, path.join(out, SOURCE_ARCHIVE_NAME))
  await fsp.chmod(path.join(out, SOURCE_ARCHIVE_NAME), 0o644)
  // The exact recipe is also useful offline in the shipped resource directory.
  await fsp.copyFile(path.join(ROOT, 'scripts', 'prepare-ffprobe.cjs'), path.join(out, 'BUILD-SCRIPT.cjs'))
  await fsp.chmod(path.join(out, 'BUILD-SCRIPT.cjs'), 0o644)
  if (target.platform === 'win32') {
    const zigLicense = path.join(ZIG_DIR, 'package', 'LICENSE')
    if (!fs.existsSync(zigLicense)) throw new Error('Zig LICENSE missing; run the Windows build first')
    await fsp.copyFile(zigLicense, path.join(out, 'ZIG-LICENSE'))
  }

  const configureLines = target.platform === 'win32'
    ? [
        './configure --target-os=mingw32 --enable-cross-compile --arch=x86_64 --enable-debug=0 --disable-stripping',
        ...COMMON.map((flag) => `  ${flag}`),
      ]
    : [
        './configure --arch=' + (target.arch === 'arm64' ? 'arm64' : 'x86_64') +
          (target.arch === process.arch ? '' : ' --target-os=darwin') +
          ' --disable-debug',
        ...COMMON.map((flag) => `  ${flag}`),
      ]
  const source = [
    `FFmpeg ${FFMPEG_VERSION}`,
    `Target: ${target.platform}-${target.arch}`,
    `Source: ${FFMPEG_URL}`,
    `Source SHA-256: ${FFMPEG_SHA256}`,
    `Corresponding source archive included here: ${SOURCE_ARCHIVE_NAME}`,
    'License: LGPL-2.1-or-later (built without --enable-gpl and --enable-nonfree)',
    'License text: LICENSE (LGPL-2.1), LICENSE.md (FFmpeg overview)',
    `Toolchain: ${toolchain}`,
    ...(target.platform === 'win32'
      ? [
          `Toolchain source: ${ZIG_URL}`,
          `Toolchain SHA-512: ${ZIG_SHA512}`,
          'Windows build uses Zig mingw-w64 runtime; see ZIG-LICENSE and BUILD.md.',
        ]
      : []),
    'Configure:',
    ...configureLines,
    `Build: make ${target.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'}`,
    'Recipe: BUILD.md; exact bootstrap script: BUILD-SCRIPT.cjs',
    'Upstream: https://ffmpeg.org/',
  ].join('\n') + '\n'
  await fsp.writeFile(path.join(out, 'SOURCE.txt'), source)

  const build = [
    `# ffprobe ${FFMPEG_VERSION} — ${target.platform}-${target.arch}`,
    '',
    `Corresponding source: \`${SOURCE_ARCHIVE_NAME}\` in this directory.`,
    `Source SHA-256: \`${FFMPEG_SHA256}\``,
    `Upstream: ${FFMPEG_URL}`,
    '',
    '## License',
    'LGPL-2.1-or-later; see `LICENSE` and `LICENSE.md`.',
    'Built without `--enable-gpl` and `--enable-nonfree`.',
    '',
    '## Toolchain',
    toolchain,
    ...(target.platform === 'win32'
      ? [
          '',
          `Zig archive: ${ZIG_URL}`,
          `Zig SHA-512: \`${ZIG_SHA512}\``,
          'Zig license: `ZIG-LICENSE`. The linked mingw-w64 runtime is part of Zig.',
          'Configure uses `--target-os=mingw32 --enable-debug=0 --disable-stripping`',
          'and `llvm-nm`; this avoids FFmpeg’s legacy binutils PE workaround.',
        ]
      : []),
    '',
    '## Configure',
    '```',
    ...configureLines,
    '```',
    '',
    '## Build',
    '```',
    `make -j4 ${target.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'}`,
    '```',
    '',
    '`BUILD-SCRIPT.cjs` is the bootstrap script used for this directory.',
  ].join('\n') + '\n'
  await fsp.writeFile(path.join(out, 'BUILD.md'), build)
}

function binaryArch(file) {
  const b = fs.readFileSync(file)
  if (b.length >= 8 && b.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = b.readUInt32LE(4)
    return cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : `macho-${cpu.toString(16)}`
  }
  if (b.length >= 0x40 && b[0] === 0x4d && b[1] === 0x5a) {
    const pe = b.readUInt32LE(0x3c)
    if (b.toString('ascii', pe, pe + 4) === 'PE\0\0') {
      return b.readUInt16LE(pe + 4) === 0x8664 ? 'x64' : `pe-${b.readUInt16LE(pe + 4).toString(16)}`
    }
  }
  return 'unknown'
}

function verifyBinary(target, file) {
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`)
  const st = fs.statSync(file)
  if (!st.isFile() || st.size < 1_000_000) throw new Error(`suspicious binary size: ${file} (${st.size})`)
  if (target.platform !== 'win32' && (st.mode & 0o111) === 0) throw new Error(`not executable: ${file}`)
  const arch = binaryArch(file)
  if (arch !== target.arch) throw new Error(`arch mismatch ${file}: ${arch} != ${target.arch}`)
  const bytes = fs.readFileSync(file, 'latin1')
  if (!bytes.includes('--disable-gpl') || !bytes.includes('--disable-nonfree')) {
    throw new Error(`binary does not embed the LGPL build flags: ${file}`)
  }
  if (bytes.includes('--enable-gpl') || bytes.includes('--enable-nonfree')) {
    throw new Error(`GPL/nonfree flag found in ${file}`)
  }
  if (!bytes.includes(FFMPEG_VERSION)) throw new Error(`FFmpeg version not found in ${file}`)
  // Native execution is a stronger check. x64-on-arm64 uses Rosetta when it is
  // installed; a clean build host without Rosetta still validates arch/config.
  const native = target.platform === process.platform && target.arch === process.arch
  const rosetta = target.platform === 'darwin' && target.arch === 'x64' && process.arch === 'arm64'
  if (native || rosetta) {
    const command = rosetta ? 'arch' : file
    const args = rosetta ? ['-x86_64', file, '-hide_banner', '-version'] : ['-hide_banner', '-version']
    try {
      const output = capture(command, args, 20_000)
      if (!output.includes(`ffprobe version ${FFMPEG_VERSION}`)) throw new Error(`unexpected version: ${file}`)
      if (!output.includes('--disable-gpl') || output.includes('--enable-nonfree')) throw new Error(`non-LGPL config: ${file}`)
    } catch (error) {
      if (native) throw new Error(`cannot run ${file}: ${error.message}`)
      log(`${target.dir}: Rosetta run skipped (${error.message.split('\n')[0]})`)
    }
  }
}

function verifyTarget(name) {
  const target = TARGETS[name]
  const out = path.join(VENDOR, target.dir)
  const required = ['LICENSE', 'LICENSE.md', 'SOURCE.txt', 'BUILD.md', 'BUILD-SCRIPT.cjs', SOURCE_ARCHIVE_NAME]
  if (target.platform === 'win32') required.push('ZIG-LICENSE')
  for (const file of required) {
    if (!fs.existsSync(path.join(out, file))) throw new Error(`missing ${target.dir}/${file}`)
  }
  const source = fs.readFileSync(path.join(out, 'SOURCE.txt'), 'utf8')
  if (!source.includes(FFMPEG_URL) || !source.includes(FFMPEG_SHA256)) throw new Error(`source metadata incomplete: ${target.dir}`)
  if (!source.includes(SOURCE_ARCHIVE_NAME)) throw new Error(`corresponding source not referenced: ${target.dir}`)
  if (!source.includes('--disable-gpl') || !source.includes('--disable-nonfree')) throw new Error(`license flags missing: ${target.dir}`)
  const archive = path.join(out, SOURCE_ARCHIVE_NAME)
  const archiveHash = sha(archive, 'sha256')
  if (archiveHash !== FFMPEG_SHA256) throw new Error(`source archive SHA mismatch: ${target.dir}`)
  verifyBinary(target, path.join(out, target.exe))
}

function verifyManifest(names) {
  const manifestPath = path.join(VENDOR, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`missing ${manifestPath}; run prepare before packaging`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  for (const name of names) {
    const target = TARGETS[name]
    const entry = manifest[name]
    if (!entry) throw new Error(`manifest has no entry for ${name}`)
    if (entry.binary !== `${target.dir}/${target.exe}`) throw new Error(`manifest binary path mismatch: ${name}`)
    if (entry.arch !== target.arch || entry.platform !== target.platform) throw new Error(`manifest target mismatch: ${name}`)
    if (entry.source !== FFMPEG_URL || entry.sourceSha256 !== FFMPEG_SHA256) throw new Error(`manifest source pin mismatch: ${name}`)
    if (entry.sourceArchive !== `${target.dir}/${SOURCE_ARCHIVE_NAME}`) throw new Error(`manifest source archive path mismatch: ${name}`)
    const binary = path.join(VENDOR, target.dir, target.exe)
    if (!fs.existsSync(binary)) throw new Error(`missing ${binary}`)
    const actual = sha(binary, 'sha256')
    if (actual !== entry.sha256) throw new Error(`manifest SHA mismatch: ${name} (${actual} != ${entry.sha256})`)
    const archive = path.join(VENDOR, target.dir, SOURCE_ARCHIVE_NAME)
    if (!fs.existsSync(archive)) throw new Error(`missing ${archive}`)
    const archiveHash = sha(archive, 'sha256')
    if (archiveHash !== entry.sourceArchiveSha256 || archiveHash !== FFMPEG_SHA256) {
      throw new Error(`manifest source archive SHA mismatch: ${name}`)
    }
  }
}

async function writeManifest() {
  const entries = {}
  for (const name of Object.keys(TARGETS)) {
    const target = TARGETS[name]
    const out = path.join(VENDOR, target.dir)
    if (!fs.existsSync(path.join(out, target.exe))) continue
    entries[name] = {
      binary: `${target.dir}/${target.exe}`,
      sha256: sha(path.join(out, target.exe), 'sha256'),
      arch: target.arch,
      platform: target.platform,
      license: `${target.dir}/LICENSE`,
      source: FFMPEG_URL,
      sourceSha256: FFMPEG_SHA256,
      sourceArchive: `${target.dir}/${SOURCE_ARCHIVE_NAME}`,
      sourceArchiveSha256: sha(path.join(out, SOURCE_ARCHIVE_NAME), 'sha256'),
      buildRecipe: `${target.dir}/BUILD.md`,
    }
  }
  await ensureDir(VENDOR)
  await fsp.writeFile(path.join(VENDOR, 'manifest.json'), JSON.stringify(entries, null, 2) + '\n')
}

async function main() {
  if (verifyOnly) {
    // Strict read-only gate: manifest hashes, source archives and embedded
    // config are compared as shipped; nothing is generated or repaired here.
    verifyManifest(selected)
    for (const name of selected) {
      verifyTarget(name)
      log(`${name}: OK (${TARGETS[name].dir})`)
    }
    log('all requested binaries verified (read-only)')
    return
  }

  await ensureDir(VENDOR)
  await ensureDir(BUILD)
  await ensureSource()
  if (!metadataOnly) {
    for (const name of selected) {
      const target = TARGETS[name]
      if (target.platform === 'win32') await buildWindows(target)
      else await buildMac(target)
    }
  } else {
    for (const name of selected) {
      const target = TARGETS[name]
      const out = path.join(VENDOR, target.dir)
      if (!fs.existsSync(path.join(out, target.exe))) {
        throw new Error(`--metadata-only needs ${target.dir}/${target.exe}`)
      }
      await deliverMetadata(
        target,
        out,
        target.platform === 'win32'
          ? 'Zig 0.14.0-dev.2456 +a68119f8f --target x86_64-windows-gnu'
          : 'Apple clang source build (LGPL, --disable-gpl --disable-nonfree)',
      )
    }
  }
  await writeManifest()
  for (const name of selected) {
    verifyTarget(name)
    log(`${name}: OK (${TARGETS[name].dir})`)
  }
  log('all requested binaries verified')
}

main().catch((error) => {
  console.error(`[ffprobe] ERROR: ${error.message}`)
  process.exitCode = 1
})
