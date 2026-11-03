'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PIN = '6b68a5b4fdeca6130b851e5f9366467a844860e5';
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'prepare-spout.cjs');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// A tiny structurally valid Windows PE image. Enough for the preflight parser:
// MZ, e_lfanew, PE signature, COFF machine/characteristics, optional magic.
function peBuffer({ machine = 0x8664, magic = 0x20b, dll = true } = {}) {
  const buffer = Buffer.alloc(0x200, 0);
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write('PE\0\0', 0x80, 'latin1');
  buffer.writeUInt16LE(machine, 0x84);
  buffer.writeUInt16LE(1, 0x86);
  buffer.writeUInt16LE(0xf0, 0x94);
  buffer.writeUInt16LE(dll ? 0x2002 : 0x0002, 0x96);
  buffer.writeUInt16LE(magic, 0x98);
  return buffer;
}

const FAKE_CMAKE = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);

function pe(machine) {
  const buffer = Buffer.alloc(0x200, 0);
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write('PE\\0\\0', 0x80, 'latin1');
  buffer.writeUInt16LE(machine, 0x84);
  buffer.writeUInt16LE(1, 0x86);
  buffer.writeUInt16LE(0xf0, 0x94);
  buffer.writeUInt16LE(0x2002, 0x96);
  buffer.writeUInt16LE(0x20b, 0x98);
  return buffer;
}

if (args.includes('--version')) {
  console.log('cmake version 3.99.0');
  process.exit(0);
}

if (args.includes('-S') && args.includes('-B')) {
  const b = args[args.indexOf('-B') + 1];
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, 'CMakeCache.txt'), 'fake cmake cache\\n');
  process.exit(0);
}

if (args[0] === '--build') {
  if (process.env.FAKE_CMAKE_FAIL === '1') {
    console.error('fake cmake: forced build failure');
    process.exit(7);
  }
  const b = args[1];
  const machine = process.env.FAKE_CMAKE_MACHINE
    ? Number(process.env.FAKE_CMAKE_MACHINE)
    : 0x8664;
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, 'cuedeck_spout_gpu.dll'), pe(machine));
  process.exit(0);
}

console.error('fake cmake: unsupported arguments ' + args.join(' '));
process.exit(2);
`;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue deck spout '));
  const script = path.join(root, 'scripts', 'prepare-spout.cjs');
  write(script, fs.readFileSync(SCRIPT));

  const sender = path.join(root, 'native', 'spout-sender');
  write(
    path.join(sender, 'CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.24)\nproject(fixture LANGUAGES CXX)\nadd_library(cuedeck_spout_gpu SHARED src/spout_gpu_native.cpp)\n',
  );
  write(path.join(sender, 'src', 'spout_gpu_native.cpp'), '// fixture sender\n');

  const sdk = path.join(root, 'sdk with spaces', `Spout2-${PIN}`);
  const sdkFiles = {
    'SPOUTSDK/SpoutDirectX/SpoutDX/SpoutDX.cpp': '// SpoutDX fixture\n',
    'SPOUTSDK/SpoutDirectX/SpoutDX/SpoutDX.h': '// SpoutDX header fixture\n',
    'SPOUTSDK/SpoutGL/SpoutSender.cpp': '// SpoutSender fixture\n',
    'SPOUTSDK/SpoutGL/SpoutCopy.cpp': '// SpoutCopy fixture\n',
    'SPOUTSDK/SpoutGL/Spout.h': '// Spout header fixture\n',
    LICENSE: 'BSD 2-Clause License\n\nCopyright (c) fixture\n',
  };
  for (const [rel, content] of Object.entries(sdkFiles)) {
    write(path.join(sdk, ...rel.split('/')), content);
  }

  const toolchain = path.join(root, 'tools with spaces', 'toolchain.cmake');
  write(
    toolchain,
    'set(CMAKE_SYSTEM_NAME Windows)\nset(CMAKE_SYSTEM_PROCESSOR AMD64)\n',
  );

  const fakeCmake = path.join(root, 'fake cmake', 'cmake.cjs');
  write(fakeCmake, FAKE_CMAKE);
  fs.chmodSync(fakeCmake, 0o755);

  return { root, script, sender, sdk, toolchain, fakeCmake };
}

function runCli(fixture, options = {}) {
  const {
    extra = [],
    sdk = fixture.sdk,
    toolchain = fixture.toolchain,
    cmake = fixture.fakeCmake,
    env = {},
  } = options;
  const args = [fixture.script];
  if (sdk !== null) args.push('--sdk', sdk);
  if (toolchain !== null) args.push('--toolchain', toolchain);
  if (cmake !== null) args.push('--cmake', cmake);
  args.push(...extra);
  return spawnSync(process.execPath, args, {
    cwd: fixture.root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function manifestPath(fixture) {
  return path.join(fixture.sender, 'build', 'build-manifest.json');
}

function dllPath(fixture) {
  return path.join(fixture.sender, 'build', 'cuedeck_spout_gpu.dll');
}

function readManifest(fixture) {
  return JSON.parse(fs.readFileSync(manifestPath(fixture), 'utf8'));
}

function outputOf(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label} failed:\n${outputOf(result)}`);
}

function assertFailed(result, pattern, label) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded:\n${outputOf(result)}`);
  assert.match(outputOf(result), pattern, `${label} did not report the expected error:\n${outputOf(result)}`);
}

function cleanup(t, fixture) {
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
}

test('build writes a manifest only after a valid AMD64 DLL and verify-only accepts it', (t) => {
  const fx = createFixture();
  cleanup(t, fx);
  assert.ok(fx.root.includes(' '), 'fixture root should contain a space');
  assert.ok(fx.sdk.includes(' '), 'SDK path should contain a space');

  const built = runCli(fx);
  assertOk(built, 'build');
  assert.ok(fs.existsSync(dllPath(fx)));
  assert.ok(fs.existsSync(manifestPath(fx)));

  const manifest = readManifest(fx);
  assert.equal(manifest.target, 'cuedeck_spout_gpu');
  assert.equal(manifest.runtimeVerified, false);
  assert.equal(manifest.sdk.pin, PIN);
  assert.equal(manifest.dll.sha256, sha256File(dllPath(fx)));
  assert.equal(manifest.dll.machine, 'AMD64');
  assert.equal(manifest.dll.peFormat, 'PE32+');
  assert.equal(manifest.source.sha256, sha256File(path.join(fx.sender, 'src', 'spout_gpu_native.cpp')));
  assert.equal(manifest.cmake.sha256, sha256File(path.join(fx.sender, 'CMakeLists.txt')));

  const verified = runCli(fx, { extra: ['--verify-only'] });
  assertOk(verified, 'verify-only');
  assert.match(verified.stdout, /Packaging preflight OK/);
  assert.match(outputOf(verified), /NOT verified/);
});

test('verify-only works without a CMake executable', (t) => {
  const fx = createFixture();
  cleanup(t, fx);
  assertOk(runCli(fx), 'build');

  const verified = runCli(fx, {
    extra: ['--verify-only'],
    cmake: path.join(fx.root, 'missing cmake', 'cmake'),
  });
  assertOk(verified, 'verify-only without cmake');
});

test('verify-only reports a missing manifest and writes nothing', (t) => {
  const fx = createFixture();
  cleanup(t, fx);

  const verified = runCli(fx, { extra: ['--verify-only'] });
  assertFailed(verified, /build manifest not found/i, 'missing manifest');
  assert.equal(fs.existsSync(manifestPath(fx)), false);
});

test('verify-only rejects malformed JSON and corrupt manifest fields', (t) => {
  const fx = createFixture();
  cleanup(t, fx);
  assertOk(runCli(fx), 'build');

  fs.writeFileSync(manifestPath(fx), '{not valid json');
  assertFailed(
    runCli(fx, { extra: ['--verify-only'] }),
    /not valid JSON/i,
    'invalid JSON manifest',
  );

  fs.writeFileSync(
    manifestPath(fx),
    JSON.stringify({ schemaVersion: 1, target: 'cuedeck_spout_gpu', runtimeVerified: false }),
  );
  assertFailed(
    runCli(fx, { extra: ['--verify-only'] }),
    /corrupt|missing dll/i,
    'manifest without fields',
  );
});

test('verify-only rejects a source changed after the build', (t) => {
  const fx = createFixture();
  cleanup(t, fx);
  assertOk(runCli(fx), 'build');

  fs.appendFileSync(path.join(fx.sender, 'src', 'spout_gpu_native.cpp'), '// changed\n');
  assertFailed(
    runCli(fx, { extra: ['--verify-only'] }),
    /source hash mismatch/i,
    'stale source',
  );
});

test('verify-only rejects a CMakeLists.txt changed after the build', (t) => {
  const fx = createFixture();
  cleanup(t, fx);
  assertOk(runCli(fx), 'build');

  fs.appendFileSync(path.join(fx.sender, 'CMakeLists.txt'), '# changed\n');
  assertFailed(
    runCli(fx, { extra: ['--verify-only'] }),
    /CMake hash mismatch/i,
    'stale CMakeLists',
  );
});

test('verify-only rejects a changed SDK fingerprint', (t) => {
  const fx = createFixture();
  cleanup(t, fx);
  assertOk(runCli(fx), 'build');

  fs.appendFileSync(path.join(fx.sdk, 'SPOUTSDK', 'SpoutDirectX', 'SpoutDX', 'SpoutDX.cpp'), '// changed\n');
  assertFailed(
    runCli(fx, { extra: ['--verify-only'] }),
    /SDK fingerprint mismatch/i,
    'stale SDK',
  );
});

test('verify-only rejects a missing, corrupt or wrong-machine DLL', (t) => {
  const fx = createFixture();
  cleanup(t, fx);
  assertOk(runCli(fx), 'build');

  fs.unlinkSync(dllPath(fx));
  assertFailed(
    runCli(fx, { extra: ['--verify-only'] }),
    /DLL not found/i,
    'missing DLL',
  );

  fs.writeFileSync(dllPath(fx), peBuffer());
  const manifest = readManifest(fx);
  manifest.dll.sha256 = sha256File(dllPath(fx));
  manifest.dll.size = fs.statSync(dllPath(fx)).size;
  fs.writeFileSync(manifestPath(fx), `${JSON.stringify(manifest, null, 2)}\n`);
  assertOk(runCli(fx, { extra: ['--verify-only'] }), 'restored DLL');

  fs.writeFileSync(dllPath(fx), peBuffer({ machine: 0x14c }));
  manifest.dll.sha256 = sha256File(dllPath(fx));
  manifest.dll.size = fs.statSync(dllPath(fx)).size;
  fs.writeFileSync(manifestPath(fx), `${JSON.stringify(manifest, null, 2)}\n`);
  assertFailed(
    runCli(fx, { extra: ['--verify-only'] }),
    /expected AMD64|is not AMD64/i,
    'wrong machine',
  );

  fs.writeFileSync(dllPath(fx), peBuffer());
  manifest.dll.sha256 = '0'.repeat(64);
  manifest.dll.size = fs.statSync(dllPath(fx)).size;
  fs.writeFileSync(manifestPath(fx), `${JSON.stringify(manifest, null, 2)}\n`);
  assertFailed(
    runCli(fx, { extra: ['--verify-only'] }),
    /SHA-256 mismatch/i,
    'corrupt DLL',
  );
});

test('a failed build creates no manifest', (t) => {
  const fx = createFixture();
  cleanup(t, fx);

  const built = runCli(fx, { env: { FAKE_CMAKE_FAIL: '1' } });
  assertFailed(built, /CMake build .*failed with exit code 7/i, 'failed build');
  assert.equal(fs.existsSync(manifestPath(fx)), false);
  assert.equal(fs.existsSync(dllPath(fx)), false);
});

test('a failed rebuild does not replace an existing valid manifest', (t) => {
  const fx = createFixture();
  cleanup(t, fx);
  assertOk(runCli(fx), 'build');
  const before = fs.readFileSync(manifestPath(fx));
  const beforeSha = sha256File(manifestPath(fx));

  const failed = runCli(fx, { env: { FAKE_CMAKE_FAIL: '1' } });
  assertFailed(failed, /failed with exit code 7/i, 'failed rebuild');
  assert.deepEqual(fs.readFileSync(manifestPath(fx)), before);
  assert.equal(sha256File(manifestPath(fx)), beforeSha);

  // The old artifact is still internally consistent, so packaging preflight
  // remains valid rather than silently accepting a half-written new manifest.
  assertOk(runCli(fx, { extra: ['--verify-only'] }), 'verify after failed rebuild');
});

test('a wrong-machine build fails after compile and writes no manifest', (t) => {
  const fx = createFixture();
  cleanup(t, fx);

  const built = runCli(fx, { env: { FAKE_CMAKE_MACHINE: String(0x14c) } });
  assertFailed(built, /expected AMD64/i, 'wrong-machine build');
  assert.equal(fs.existsSync(manifestPath(fx)), false);
});

test('cross-compilation on macOS requires an explicit Windows toolchain', (t) => {
  if (process.platform === 'win32') {
    t.skip('native Windows build does not need a toolchain');
    return;
  }
  const fx = createFixture();
  cleanup(t, fx);

  const built = runCli(fx, { toolchain: null, extra: [] });
  assertFailed(built, /requires an explicit toolchain|SPOUT2_TOOLCHAIN/i, 'no toolchain');
  assert.equal(fs.existsSync(manifestPath(fx)), false);
  assert.equal(fs.existsSync(dllPath(fx)), false);
});

test('a toolchain without a Windows target declaration is rejected before build', (t) => {
  const fx = createFixture();
  cleanup(t, fx);
  const hostToolchain = path.join(fx.root, 'tools with spaces', 'host.cmake');
  write(hostToolchain, 'set(CMAKE_SYSTEM_NAME Darwin)\n');

  const built = runCli(fx, { toolchain: hostToolchain });
  assertFailed(built, /CMAKE_SYSTEM_NAME Windows/i, 'non-Windows toolchain');
  assert.equal(fs.existsSync(manifestPath(fx)), false);
});

test('an SDK without the pinned commit is rejected before build', (t) => {
  const fx = createFixture();
  cleanup(t, fx);
  const renamed = path.join(fx.root, 'sdk with spaces', 'Spout2-unpinned');
  fs.renameSync(fx.sdk, renamed);

  const built = runCli(fx, { sdk: renamed });
  assertFailed(built, /cannot prove the Spout2 pin|pin mismatch/i, 'unpinned SDK');
  assert.equal(fs.existsSync(manifestPath(fx)), false);
});

test('an SDK pin marker file can identify a renamed pinned tree', (t) => {
  const fx = createFixture();
  cleanup(t, fx);
  const renamed = path.join(fx.root, 'sdk with spaces', 'Spout2-local');
  fs.renameSync(fx.sdk, renamed);
  fs.writeFileSync(path.join(renamed, 'SPOUT2_PIN'), `${PIN}\n`);

  assertOk(runCli(fx, { sdk: renamed }), 'build with pin marker');
  const manifest = readManifest(fx);
  assert.equal(manifest.sdk.pinSource, 'SPOUT2_PIN');
  assertOk(runCli(fx, { sdk: renamed, extra: ['--verify-only'] }), 'verify with pin marker');
});

test('SDK and toolchain can be supplied through the documented environment variables', (t) => {
  const fx = createFixture();
  cleanup(t, fx);
  const env = { SPOUT2_ROOT: fx.sdk, SPOUT2_TOOLCHAIN: fx.toolchain };

  assertOk(runCli(fx, { sdk: null, toolchain: null, env }), 'build from env');
  assertOk(
    runCli(fx, { sdk: null, toolchain: null, env, extra: ['--verify-only'] }),
    'verify from env',
  );
});

test('unknown options fail without writing artifacts', (t) => {
  const fx = createFixture();
  cleanup(t, fx);

  const result = runCli(fx, { extra: ['--bogus'] });
  assertFailed(result, /unknown option/i, 'unknown option');
  assert.equal(fs.existsSync(manifestPath(fx)), false);
});
