#!/usr/bin/env node
'use strict';

// Reproducible build + packaging preflight for the CueDeck Spout GPU sender.
//
// This script never downloads anything and never uses an npm package. The
// official Spout2 tree and, when cross-compiling, the toolchain file must be
// passed explicitly. It only proves that the DLL on disk matches the sources
// that produced it; it does NOT prove that Spout works at runtime.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SPOUT2_PIN = '6b68a5b4fdeca6130b851e5f9366467a844860e5';
const SPOUT2_DIR_NAME = `Spout2-${SPOUT2_PIN}`;
const DEFAULT_TARGET = 'cuedeck_spout_gpu';
const MANIFEST_SCHEMA = 1;
const MIN_CMAKE = [3, 24, 0];
const SENDER_DIR = path.join(REPO_ROOT, 'native', 'spout-sender');
const DEFAULT_BUILD_DIR = path.join(SENDER_DIR, 'build');
const DEFAULT_OUT = path.join(DEFAULT_BUILD_DIR, `${DEFAULT_TARGET}.dll`);
const DEFAULT_MANIFEST = path.join(DEFAULT_BUILD_DIR, 'build-manifest.json');

const REQUIRED_SDK_FILES = [
  'SPOUTSDK/SpoutDirectX/SpoutDX/SpoutDX.cpp',
  'SPOUTSDK/SpoutDirectX/SpoutDX/SpoutDX.h',
  'SPOUTSDK/SpoutGL/SpoutSender.cpp',
  'SPOUTSDK/SpoutGL/SpoutCopy.cpp',
  'SPOUTSDK/SpoutGL/Spout.h',
  'LICENSE',
];

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

function usage() {
  return `Usage:
  node scripts/prepare-spout.cjs [options]
  node scripts/prepare-spout.cjs --verify-only [options]

Build the Windows x64 Spout sender (target ${DEFAULT_TARGET}) and write a
build manifest only after the DLL itself has been checked.

Options:
  --sdk <dir>        Pinned official Spout2 source root (or SPOUT2_ROOT).
                     Directory name must be ${SPOUT2_DIR_NAME} or it must
                     contain SPOUT2_PIN / .spout2-pin with the same commit.
  --toolchain <file> C++ toolchain file (or SPOUT2_TOOLCHAIN). Required on
                     macOS/Linux; optional on Windows (native VS2022 build).
  --cmake <file>     CMake executable (or SPOUT2_CMAKE; default: cmake).
  --build-dir <dir>  Build directory (default: native/spout-sender/build).
  --out <file>       Expected DLL path
                     (default: native/spout-sender/build/${DEFAULT_TARGET}.dll).
  --manifest <file>  Manifest path
                     (default: native/spout-sender/build/build-manifest.json).
  --target <name>    CMake target (default: ${DEFAULT_TARGET}).
  --generator <name> Explicit CMake generator (otherwise VS2022 on Windows).
  --jobs <n>         Pass --parallel <n> to cmake --build.
  --verify-only      No build. Check manifest, source, CMake, SDK pin and DLL.
  --help             Show this text.

The build manifest is local and is written atomically. A failed build never
creates or replaces it. --verify-only never writes anything.
Runtime Spout/DXGI behaviour is not verified by this script.`;
}

function parseArgs(argv) {
  const opts = {
    verifyOnly: false,
    help: false,
    sdk: undefined,
    toolchain: undefined,
    cmake: undefined,
    buildDir: undefined,
    out: undefined,
    manifest: undefined,
    target: undefined,
    generator: undefined,
    jobs: undefined,
  };
  const valueOptions = {
    '--sdk': 'sdk',
    '--toolchain': 'toolchain',
    '--cmake': 'cmake',
    '--build-dir': 'buildDir',
    '--out': 'out',
    '--manifest': 'manifest',
    '--target': 'target',
    '--generator': 'generator',
    '--jobs': 'jobs',
  };

  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    if (arg === '--verify-only') {
      opts.verifyOnly = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }

    let value;
    if (arg.includes('=')) {
      const eq = arg.indexOf('=');
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const key = valueOptions[arg];
    if (!key) fail(`unknown option: ${arg}\n\n${usage()}`);
    if (value === undefined) {
      i += 1;
      if (i >= argv.length) fail(`missing value for ${arg}`);
      value = argv[i];
    }
    if (value === '') fail(`empty value for ${arg}`);
    if (opts[key] !== undefined) fail(`option ${arg} was given more than once`);
    opts[key] = value;
  }
  return opts;
}

function resolveFromCwd(value) {
  if (value.includes('\0')) fail('paths must not contain NUL bytes');
  return path.resolve(process.cwd(), value);
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function requireFile(file, what) {
  if (!isFile(file)) fail(`${what} not found: ${file}`);
}

function hashFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (error) {
    fail(`cannot read file ${file}: ${error.message}`);
  }
}

function walkFiles(root) {
  const out = [];
  function walk(dir, relDir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      fail(`cannot read SDK directory ${dir}: ${error.message}`);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        fail(`SDK tree contains a symlink, refusing ambiguous fingerprint: ${full}`);
      }
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        out.push({ full, rel });
      } else {
        fail(`SDK tree contains an unsupported file entry: ${full}`);
      }
    }
  }
  walk(root, '');
  out.sort((a, b) => a.rel.localeCompare(b.rel, 'en'));
  return out;
}

function hashTree(root) {
  const hash = crypto.createHash('sha256');
  for (const entry of walkFiles(root)) {
    let stat;
    try {
      stat = fs.statSync(entry.full);
    } catch (error) {
      fail(`cannot stat SDK file ${entry.full}: ${error.message}`);
    }
    hash.update(entry.rel);
    hash.update('\0');
    hash.update(String(stat.size));
    hash.update('\0');
    hash.update(hashFile(entry.full));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function readPinMarker(sdkRoot) {
  for (const name of ['SPOUT2_PIN', '.spout2-pin']) {
    const marker = path.join(sdkRoot, name);
    if (!isFile(marker)) continue;
    const value = fs.readFileSync(marker, 'utf8').trim();
    if (!value) fail(`SDK pin marker is empty: ${marker}`);
    return { pin: value, source: name };
  }
  return null;
}

function validateSdk(sdkInput) {
  if (!sdkInput) {
    fail('SDK root is required: pass --sdk <dir> or set SPOUT2_ROOT');
  }
  const root = resolveFromCwd(sdkInput);
  if (!isDirectory(root)) fail(`SDK root is not a directory: ${root}`);

  for (const rel of REQUIRED_SDK_FILES) {
    const full = path.join(root, ...rel.split('/'));
    if (!isFile(full)) {
      fail(`SDK root does not look like the pinned Spout2 tree: missing ${rel} (in ${root})`);
    }
  }

  const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  if (!/BSD 2-Clause License/i.test(license)) {
    fail(`SDK LICENSE is not BSD-2-Clause: ${path.join(root, 'LICENSE')}`);
  }

  const marker = readPinMarker(root);
  let pin;
  let pinSource;
  if (path.basename(root) === SPOUT2_DIR_NAME) {
    pin = SPOUT2_PIN;
    pinSource = 'directory-name';
  } else if (marker) {
    pin = marker.pin;
    pinSource = marker.source;
  } else {
    fail(
      `cannot prove the Spout2 pin: directory must be named ${SPOUT2_DIR_NAME} ` +
        `or contain SPOUT2_PIN / .spout2-pin with the pinned commit (got ${root})`,
    );
  }
  if (pin !== SPOUT2_PIN) {
    fail(`Spout2 pin mismatch: expected ${SPOUT2_PIN}, found ${pin} in ${root}`);
  }

  const treeSha256 = hashTree(path.join(root, 'SPOUTSDK'));
  const licenseSha256 = hashFile(path.join(root, 'LICENSE'));
  return {
    root,
    rootName: path.basename(root),
    pin,
    pinSource,
    treeSha256,
    licenseSha256,
  };
}

function validateToolchain(toolchainInput) {
  const cross = process.platform !== 'win32';
  if (!toolchainInput) {
    if (cross) {
      fail(
        `cross-compilation from ${process.platform} requires an explicit toolchain: ` +
          'pass --toolchain <file> or set SPOUT2_TOOLCHAIN (no toolchain is assumed)',
      );
    }
    return null;
  }

  const toolchain = resolveFromCwd(toolchainInput);
  if (!isFile(toolchain)) fail(`toolchain file not found: ${toolchain}`);
  const text = fs.readFileSync(toolchain, 'utf8');
  if (!text.trim()) fail(`toolchain file is empty: ${toolchain}`);
  if (!/CMAKE_SYSTEM_NAME\s+["']?Windows/i.test(text)) {
    fail(
      `toolchain file does not declare CMAKE_SYSTEM_NAME Windows: ${toolchain}\n` +
        'refusing to cross-compile without a Windows target declaration',
    );
  }
  return { file: toolchain, sha256: hashFile(toolchain) };
}

function parseCmakeVersion(text) {
  const match = /cmake version (\d+)\.(\d+)\.(\d+)/i.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionLessThan(actual, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    if (actual[i] < minimum[i]) return true;
    if (actual[i] > minimum[i]) return false;
  }
  return false;
}

function checkCmake(cmake) {
  const result = spawnSync(cmake, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    fail(`CMake executable could not be started: ${cmake} (${result.error.message})`);
  }
  if (result.status !== 0) {
    fail(`CMake --version failed with exit code ${result.status}: ${cmake}`);
  }
  const version = parseCmakeVersion(`${result.stdout || ''}\n${result.stderr || ''}`);
  if (!version) fail(`could not parse CMake version from: ${cmake}`);
  if (versionLessThan(version, MIN_CMAKE)) {
    fail(
      `CMake ${version.join('.')} is too old; need ${MIN_CMAKE.join('.')} or newer (${cmake})`,
    );
  }
  return { executable: cmake, version: version.join('.') };
}

function runCmake(cmake, args, what) {
  const result = spawnSync(cmake, args, {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    fail(`failed to start ${what}: ${cmake} (${result.error.message})`);
  }
  if (result.status !== 0) {
    fail(`${what} failed with exit code ${result.status}: ${cmake}`);
  }
}

function relToRepo(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

function machineName(machine) {
  if (machine === 0x8664) return 'AMD64';
  if (machine === 0x014c) return 'I386';
  if (machine === 0xaa64) return 'ARM64';
  if (machine === 0x01c4) return 'ARMNT';
  return `0x${machine.toString(16).padStart(4, '0')}`;
}

function inspectPe(file) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    fail(`cannot read DLL ${file}: ${error.message}`);
  }
  if (!buffer || buffer.length < 0x40) {
    fail(`DLL is too small to be a Windows PE file: ${file}`);
  }
  if (buffer.readUInt16LE(0) !== 0x5a4d) {
    fail(`DLL is not a Windows PE file (missing MZ signature): ${file}`);
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 24 > buffer.length) {
    fail(`DLL is not a Windows PE file (bad e_lfanew ${peOffset}): ${file}`);
  }
  if (buffer.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') {
    fail(`DLL is not a Windows PE file (missing PE signature): ${file}`);
  }
  const machine = buffer.readUInt16LE(peOffset + 4);
  const characteristics = buffer.readUInt16LE(peOffset + 22);
  const optionalOffset = peOffset + 24;
  if (optionalOffset + 2 > buffer.length) {
    fail(`DLL is not a Windows PE file (truncated optional header): ${file}`);
  }
  const optionalMagic = buffer.readUInt16LE(optionalOffset);
  if (optionalMagic !== 0x20b && optionalMagic !== 0x10b) {
    fail(
      `DLL has an unknown PE optional header magic ` +
        `0x${optionalMagic.toString(16)}: ${file}`,
    );
  }
  const isDll = (characteristics & 0x2000) !== 0;
  return {
    machine,
    machineName: machineName(machine),
    optionalMagic,
    peFormat: optionalMagic === 0x20b ? 'PE32+' : 'PE32',
    isDll,
  };
}

function assertWindowsAmd64Dll(file) {
  const pe = inspectPe(file);
  if (pe.machine !== 0x8664) {
    fail(
      `DLL machine is ${pe.machineName} (0x${pe.machine
        .toString(16)
        .padStart(4, '0')}), expected AMD64 (0x8664): ${file}`,
    );
  }
  if (pe.optionalMagic !== 0x20b) {
    fail(`DLL is ${pe.peFormat}, expected PE32+ (Windows x64): ${file}`);
  }
  if (!pe.isDll) {
    fail(`PE file is not marked as a DLL: ${file}`);
  }
  return pe;
}

function listDlls(dir, depth = 0) {
  if (!isDirectory(dir) || depth > 2) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listDlls(full, depth + 1));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) {
      found.push(full);
    }
  }
  return found;
}

function collectInputs(sdk) {
  const source = path.join(SENDER_DIR, 'src', 'spout_gpu_native.cpp');
  const cmake = path.join(SENDER_DIR, 'CMakeLists.txt');
  requireFile(source, 'sender source');
  requireFile(cmake, 'sender CMakeLists.txt');
  return {
    source: { path: source, rel: relToRepo(source), sha256: hashFile(source) },
    cmake: { path: cmake, rel: relToRepo(cmake), sha256: hashFile(cmake) },
    sdk,
  };
}

function writeManifestAtomically(manifestPath, manifest) {
  const dir = path.dirname(manifestPath);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(
    dir,
    `.${path.basename(manifestPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  try {
    fs.renameSync(temp, manifestPath);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // best effort only
    }
    fail(`cannot write build manifest ${manifestPath}: ${error.message}`);
  }
}

function build(opts) {
  const sdk = validateSdk(opts.sdk || process.env.SPOUT2_ROOT);
  const toolchain = validateToolchain(
    opts.toolchain || process.env.SPOUT2_TOOLCHAIN,
  );
  const cmake = checkCmake(opts.cmake || process.env.SPOUT2_CMAKE || 'cmake');
  const inputsBefore = collectInputs(sdk);

  const buildDir = opts.buildDir ? resolveFromCwd(opts.buildDir) : DEFAULT_BUILD_DIR;
  const out = opts.out
    ? resolveFromCwd(opts.out)
    : path.join(buildDir, `${DEFAULT_TARGET}.dll`);
  const manifestPath = opts.manifest
    ? resolveFromCwd(opts.manifest)
    : path.join(buildDir, 'build-manifest.json');
  const target = opts.target || DEFAULT_TARGET;
  const jobs = opts.jobs === undefined ? null : Number(opts.jobs);
  if (jobs !== null && (!Number.isInteger(jobs) || jobs < 1)) {
    fail(`--jobs must be a positive integer, got: ${opts.jobs}`);
  }

  try {
    fs.mkdirSync(buildDir, { recursive: true });
  } catch (error) {
    fail(`cannot create build directory ${buildDir}: ${error.message}`);
  }

  const configure = [
    '-S',
    SENDER_DIR,
    '-B',
    buildDir,
    `-DSPOUT2_ROOT=${sdk.root}`,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_PROJECT_INCLUDE=',
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${buildDir}`,
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${buildDir}`,
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_DEBUG=${buildDir}`,
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO=${buildDir}`,
    `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL=${buildDir}`,
  ];
  if (toolchain) {
    configure.push(`-DCMAKE_TOOLCHAIN_FILE=${toolchain.file}`);
  }
  if (opts.generator) {
    configure.push('-G', opts.generator);
  } else if (process.platform === 'win32' && !toolchain) {
    configure.push('-G', 'Visual Studio 17 2022', '-A', 'x64');
  }

  console.log(`Spout2 SDK: ${sdk.root}`);
  console.log(`  pin ${sdk.pin} (${sdk.pinSource})`);
  console.log(`  SPOUTSDK sha256 ${sdk.treeSha256}`);
  console.log(
    `Toolchain: ${toolchain ? toolchain.file : 'none (native Windows VS2022 build)'}`,
  );
  console.log(`CMake: ${cmake.executable} (${cmake.version})`);
  console.log(`Build directory: ${buildDir}`);
  console.log(`Target: ${target}`);

  runCmake(cmake.executable, configure, 'CMake configure');
  const buildArgs = [
    '--build',
    buildDir,
    '--config',
    'Release',
    '--target',
    target,
  ];
  if (jobs !== null) buildArgs.push('--parallel', String(jobs));
  runCmake(cmake.executable, buildArgs, `CMake build (target "${target}")`);

  if (!isFile(out)) {
    const found = listDlls(buildDir);
    const hint = found.length
      ? `DLLs found instead:\n${found.map((file) => `  ${file}`).join('\n')}`
      : 'no DLL was found in the build directory';
    fail(
      `build finished but expected DLL was not produced: ${out}\n${hint}\n` +
        'The CMake target must emit exactly this DLL name (OUTPUT_NAME).',
    );
  }

  const pe = assertWindowsAmd64Dll(out);
  const dllSha256 = hashFile(out);
  const dllSize = fs.statSync(out).size;

  const inputsAfter = collectInputs(sdk);
  if (
    inputsAfter.source.sha256 !== inputsBefore.source.sha256 ||
    inputsAfter.cmake.sha256 !== inputsBefore.cmake.sha256 ||
    inputsAfter.sdk.treeSha256 !== inputsBefore.sdk.treeSha256 ||
    inputsAfter.sdk.licenseSha256 !== inputsBefore.sdk.licenseSha256
  ) {
    fail('source, CMakeLists.txt or SDK changed while the build was running; refusing a stale manifest');
  }

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    target,
    output: relToRepo(out),
    dll: {
      sha256: dllSha256,
      size: dllSize,
      machine: 'AMD64',
      peFormat: pe.peFormat,
      isDll: true,
    },
    source: {
      path: inputsAfter.source.rel,
      sha256: inputsAfter.source.sha256,
    },
    cmake: {
      path: inputsAfter.cmake.rel,
      sha256: inputsAfter.cmake.sha256,
    },
    sdk: {
      pin: sdk.pin,
      pinSource: sdk.pinSource,
      rootName: sdk.rootName,
      treeSha256: sdk.treeSha256,
      licenseSha256: sdk.licenseSha256,
    },
    build: {
      config: 'Release',
      cmakeVersion: cmake.version,
      generator: opts.generator || null,
    },
    builtAt: new Date().toISOString(),
    builtOn: { platform: process.platform, arch: process.arch },
    runtimeVerified: false,
  };

  writeManifestAtomically(manifestPath, manifest);

  console.log(`DLL: ${out}`);
  console.log(`  ${pe.machineName} ${pe.peFormat}, ${dllSize} bytes`);
  console.log(`  sha256 ${dllSha256}`);
  console.log(`Manifest written: ${manifestPath}`);
  console.log(
    'Runtime note: compile-time artifact only; Spout/DXGI runtime is NOT verified.',
  );
  return manifest;
}

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`build manifest is corrupt: ${label} must be a non-empty string`);
  }
}

function loadManifest(manifestPath, target) {
  if (!isFile(manifestPath)) {
    fail(
      `build manifest not found: ${manifestPath}\n` +
        'run prepare-spout without --verify-only before packaging',
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`build manifest is not valid JSON: ${manifestPath} (${error.message})`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail(`build manifest is corrupt: expected a JSON object in ${manifestPath}`);
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA) {
    fail(
      `build manifest is corrupt: unsupported schemaVersion ` +
        `${String(manifest.schemaVersion)} (expected ${MANIFEST_SCHEMA})`,
    );
  }
  if (manifest.target !== target) {
    fail(
      `build manifest target mismatch: manifest has ${String(manifest.target)}, ` +
        `requested ${target}`,
    );
  }
  if (manifest.runtimeVerified !== false) {
    fail(
      'build manifest is corrupt: runtimeVerified must be false; ' +
        'this script does not verify the Spout runtime',
    );
  }
  if (!manifest.dll || typeof manifest.dll !== 'object') {
    fail('build manifest is corrupt: missing dll object');
  }
  if (!manifest.source || typeof manifest.source !== 'object') {
    fail('build manifest is corrupt: missing source object');
  }
  if (!manifest.cmake || typeof manifest.cmake !== 'object') {
    fail('build manifest is corrupt: missing cmake object');
  }
  if (!manifest.sdk || typeof manifest.sdk !== 'object') {
    fail('build manifest is corrupt: missing sdk object');
  }
  requireString(manifest.output, 'output');
  requireString(manifest.dll.sha256, 'dll.sha256');
  requireString(manifest.source.path, 'source.path');
  requireString(manifest.source.sha256, 'source.sha256');
  requireString(manifest.cmake.path, 'cmake.path');
  requireString(manifest.cmake.sha256, 'cmake.sha256');
  requireString(manifest.sdk.pin, 'sdk.pin');
  requireString(manifest.sdk.treeSha256, 'sdk.treeSha256');
  requireString(manifest.sdk.licenseSha256, 'sdk.licenseSha256');
  if (!isHex64(manifest.dll.sha256)) fail('build manifest is corrupt: dll.sha256 is not a SHA-256 hex digest');
  if (!isHex64(manifest.source.sha256)) fail('build manifest is corrupt: source.sha256 is not a SHA-256 hex digest');
  if (!isHex64(manifest.cmake.sha256)) fail('build manifest is corrupt: cmake.sha256 is not a SHA-256 hex digest');
  if (!isHex64(manifest.sdk.treeSha256)) fail('build manifest is corrupt: sdk.treeSha256 is not a SHA-256 hex digest');
  if (!isHex64(manifest.sdk.licenseSha256)) fail('build manifest is corrupt: sdk.licenseSha256 is not a SHA-256 hex digest');
  if (!Number.isSafeInteger(manifest.dll.size) || manifest.dll.size < 1) {
    fail('build manifest is corrupt: dll.size must be a positive integer');
  }
  if (manifest.dll.machine !== 'AMD64') {
    fail('build manifest is corrupt: dll.machine must be AMD64');
  }
  if (manifest.dll.peFormat !== 'PE32+') {
    fail('build manifest is corrupt: dll.peFormat must be PE32+');
  }
  if (manifest.dll.isDll !== true) {
    fail('build manifest is corrupt: dll.isDll must be true');
  }
  return manifest;
}

function verify(opts) {
  const target = opts.target || DEFAULT_TARGET;
  const buildDir = opts.buildDir ? resolveFromCwd(opts.buildDir) : DEFAULT_BUILD_DIR;
  const manifestPath = opts.manifest
    ? resolveFromCwd(opts.manifest)
    : path.join(buildDir, 'build-manifest.json');
  const out = opts.out
    ? resolveFromCwd(opts.out)
    : path.join(buildDir, `${DEFAULT_TARGET}.dll`);
  const manifest = loadManifest(manifestPath, target);

  const manifestOutput = manifest.output.split('\\').join('/');
  const requestedOutput = relToRepo(out);
  if (manifestOutput !== requestedOutput) {
    fail(
      `build manifest output mismatch: manifest has ${manifestOutput}, ` +
        `requested ${requestedOutput}`,
    );
  }

  const sdk = validateSdk(opts.sdk || process.env.SPOUT2_ROOT);
  if (sdk.pin !== manifest.sdk.pin) {
    fail(
      `SDK pin mismatch: manifest has ${manifest.sdk.pin}, ` +
        `current SDK is ${sdk.pin} (${sdk.root})`,
    );
  }
  if (sdk.treeSha256 !== manifest.sdk.treeSha256) {
    fail(
      `SDK fingerprint mismatch: SPOUTSDK content changed since the manifest was written\n` +
        `  manifest ${manifest.sdk.treeSha256}\n  current  ${sdk.treeSha256}\n` +
        `  SDK root ${sdk.root}`,
    );
  }
  if (sdk.licenseSha256 !== manifest.sdk.licenseSha256) {
    fail(
      `SDK license hash mismatch: manifest ${manifest.sdk.licenseSha256}, ` +
        `current ${sdk.licenseSha256}`,
    );
  }

  const inputs = collectInputs(sdk);
  if (manifest.source.path !== inputs.source.rel) {
    fail(
      `source path mismatch: manifest has ${manifest.source.path}, ` +
        `expected ${inputs.source.rel}`,
    );
  }
  if (manifest.cmake.path !== inputs.cmake.rel) {
    fail(
      `CMake path mismatch: manifest has ${manifest.cmake.path}, ` +
        `expected ${inputs.cmake.rel}`,
    );
  }
  if (inputs.source.sha256 !== manifest.source.sha256) {
    fail(
      `source hash mismatch: ${inputs.source.rel} changed since the manifest was written\n` +
        `  manifest ${manifest.source.sha256}\n  current  ${inputs.source.sha256}`,
    );
  }
  if (inputs.cmake.sha256 !== manifest.cmake.sha256) {
    fail(
      `CMake hash mismatch: ${inputs.cmake.rel} changed since the manifest was written\n` +
        `  manifest ${manifest.cmake.sha256}\n  current  ${inputs.cmake.sha256}`,
    );
  }

  if (!isFile(out)) fail(`DLL not found: ${out}`);
  const actualSize = fs.statSync(out).size;
  if (actualSize !== manifest.dll.size) {
    fail(
      `DLL size mismatch: manifest ${manifest.dll.size} bytes, actual ${actualSize} bytes: ${out}`,
    );
  }
  const actualSha = hashFile(out);
  if (actualSha !== manifest.dll.sha256) {
    fail(
      `DLL SHA-256 mismatch: manifest ${manifest.dll.sha256}, actual ${actualSha}: ${out}`,
    );
  }
  const pe = assertWindowsAmd64Dll(out);

  console.log('Packaging preflight OK');
  console.log(`  DLL: ${out}`);
  console.log(`  ${pe.machineName} ${pe.peFormat}, ${actualSize} bytes`);
  console.log(`  sha256 ${actualSha}`);
  console.log(`  Manifest: ${manifestPath}`);
  console.log('  Source, CMakeLists.txt, Spout2 pin and SDK fingerprint match.');
  console.log(
    '  Runtime note: compile-time artifact only; Spout/DXGI runtime is NOT verified.',
  );
  return manifest;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(usage());
      return;
    }
    if (opts.verifyOnly) {
      verify(opts);
    } else {
      build(opts);
    }
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.error(`error: unexpected failure: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
}

main();
