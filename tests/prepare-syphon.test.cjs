'use strict';

// Standalone Node test runner (the repo's vitest include is *.test.ts only):
//   node --test tests/prepare-syphon.test.cjs

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const prep = require('../scripts/prepare-syphon.cjs');

const COMMIT = 'a'.repeat(40);
const FRAMEWORK = '@rpath/Syphon.framework/Versions/A/Syphon';
const DYLIB = '@rpath/libcuedeck_syphon_gpu.dylib';
const tempDirs = [];

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeProbe() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuedeck syphon test-'));
  tempDirs.push(root);
  const probe = path.join(root, 'native', 'syphon-probe');
  fs.mkdirSync(path.join(probe, 'build'), { recursive: true });
  fs.mkdirSync(path.join(probe, 'patches'), { recursive: true });
  fs.mkdirSync(path.join(probe, 'src'), { recursive: true });
  fs.mkdirSync(path.join(probe, 'vendor'), { recursive: true });
  const tarball = path.join(probe, 'vendor', `syphon-framework-${COMMIT}.tar.gz`);
  fs.writeFileSync(tarball, 'pinned official syphon source');
  const buildSh = path.join(probe, 'build.sh');
  const body = `#!/bin/bash\nSYPHON_COMMIT="${COMMIT}"\nSYPHON_SHA256="${sha(tarball)}"\nMIN_MACOS="13.0"\n`;
  fs.writeFileSync(buildSh, body);
  fs.writeFileSync(path.join(probe, 'patches', 'syphon-metal-runtime-library.patch'), 'local patch');
  fs.writeFileSync(path.join(probe, 'src', 'syphon_gpu_native.m'), 'native source');
  fs.writeFileSync(path.join(probe, 'src', 'frame_protocol.h'), 'header');
  return { root, probe, buildSh, body, tarball };
}

function makeOut(probe, target) {
  const out = path.join(probe, 'build', target);
  const fw = path.join(out, 'Syphon.framework', 'Versions', 'A');
  fs.mkdirSync(fw, { recursive: true });
  fs.writeFileSync(path.join(fw, 'Syphon'), 'framework binary');
  const resources = path.join(fw, 'Resources');
  fs.mkdirSync(resources);
  for (const name of ['SyphonMetalShaders.metal', 'SyphonServerMetalTypes.h', 'Info.plist', 'License.txt']) fs.writeFileSync(path.join(resources, name), `resource ${name}`);
  fs.writeFileSync(path.join(out, 'libcuedeck_syphon_gpu.dylib'), 'dylib binary');
  return out;
}

function nativeFor(arch) {
  return {
    archs: { framework: [arch], dylib: [arch] },
    installNames: { framework: FRAMEWORK, dylib: DYLIB },
    frameworkDependency: FRAMEWORK,
  };
}

function writeManifest(out, manifest) {
  fs.writeFileSync(path.join(out, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function fixture(target = 'darwin-x64') {
  const made = makeProbe();
  const pins = prep.readPins(made.probe);
  const inputs = prep.collectInputs(made.probe, pins);
  const out = makeOut(made.probe, target);
  return { ...made, pins, inputs, out };
}

test.afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('safe output: build children and spaces pass; escapes and symlinks fail', () => {
  const { probe } = makeProbe();
  assert.equal(prep.validateOutputDir(probe, 'build/darwin-arm64'), path.join(probe, 'build', 'darwin-arm64'));
  assert.equal(prep.validateOutputDir(probe, 'build/space test/darwin-x64'), path.join(probe, 'build', 'space test', 'darwin-x64'));
  assert.throws(() => prep.validateOutputDir(probe, '/'), /unsafe output/);
  assert.throws(() => prep.validateOutputDir(probe, 'build/../native'), /under .*build/);
  assert.throws(() => prep.validateOutputDir(probe, probe), /unsafe output/);
  fs.mkdirSync(path.join(probe, 'build', 'real'));
  fs.symlinkSync(path.join(probe, 'build', 'real'), path.join(probe, 'build', 'link'));
  assert.throws(() => prep.validateOutputDir(probe, 'build/link/out'), /symlink/);
  fs.symlinkSync(path.join(probe, 'build', 'real'), path.join(probe, 'build', 'link2'));
  assert.throws(() => prep.validateOutputDir(probe, 'build/link2'), /symlink/);
});

test('actual build.sh rejects lexical traversal before creating or cleaning a sibling', () => {
  const { probe } = makeProbe();
  fs.copyFileSync(path.join(__dirname, '..', 'native', 'syphon-probe', 'build.sh'), path.join(probe, 'build.sh'));
  const sentinel = path.join(probe, 'src', 'sentinel.txt');
  fs.writeFileSync(sentinel, 'keep me');
  const result = spawnSync('/bin/bash', [path.join(probe, 'build.sh'), '--arch', 'arm64', '--output-dir', 'build/nonexistent/../../src'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /refusing \. or \.\./);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep me');
  assert.equal(fs.existsSync(path.join(probe, 'build', 'nonexistent')), false);
});

test('inputs: stable under a path with spaces and change with build.sh', () => {
  const { probe, buildSh, body, inputs } = fixture('darwin-arm64');
  assert.ok(prep.hashInputs(inputs).match(/^[0-9a-f]{64}$/));
  assert.equal(prep.hashInputs(prep.collectInputs(probe, prep.readPins(probe))), prep.hashInputs(inputs));
  fs.writeFileSync(buildSh, `${body}\n# changed\n`);
  assert.notEqual(prep.hashInputs(prep.collectInputs(probe, prep.readPins(probe))), prep.hashInputs(inputs));
});

test('manifest: missing, stale input, stale or missing artifact, wrong arch', () => {
  const { probe, buildSh, body, pins, inputs, out } = fixture();
  const good = nativeFor('x86_64');
  const manifest = prep.createManifest(out, 'darwin-x64', 'x86_64', pins, inputs, good);
  assert.throws(() => prep.verifyManifest('darwin-x64', out), /manifest missing/);

  writeManifest(out, manifest);
  assert.equal(prep.verifyManifest('darwin-x64', out, { probeDir: probe, nativeVerifier: () => good }).target, 'darwin-x64');
  assert.equal(manifest.artifacts.length, 6);
  assert.equal(manifest.artifacts.find((a) => a.path.endsWith('SyphonMetalShaders.metal')).archs, undefined);
  const shader = path.join(out, 'Syphon.framework', 'Versions', 'A', 'Resources', 'SyphonMetalShaders.metal');
  fs.appendFileSync(shader, 'tampered');
  assert.throws(() => prep.verifyManifest('darwin-x64', out, { probeDir: probe, nativeVerifier: () => good }), /stale artifact/);
  fs.writeFileSync(shader, 'resource SyphonMetalShaders.metal');

  fs.writeFileSync(buildSh, `${body}\n# changed\n`);
  assert.throws(() => prep.verifyManifest('darwin-x64', out, { probeDir: probe, nativeVerifier: () => good }), /stale manifest/);
  fs.writeFileSync(buildSh, body);

  writeManifest(out, manifest);
  fs.appendFileSync(path.join(out, 'libcuedeck_syphon_gpu.dylib'), 'tampered');
  assert.throws(() => prep.verifyManifest('darwin-x64', out, { probeDir: probe, nativeVerifier: () => good }), /stale artifact/);

  fs.rmSync(path.join(out, 'libcuedeck_syphon_gpu.dylib'));
  assert.throws(() => prep.verifyManifest('darwin-x64', out, { probeDir: probe, nativeVerifier: () => good }), /missing artifact/);

  fs.writeFileSync(path.join(out, 'libcuedeck_syphon_gpu.dylib'), 'dylib binary');
  writeManifest(out, manifest);
  assert.throws(() => prep.verifyManifest('darwin-x64', out, { probeDir: probe, nativeVerifier: () => nativeFor('arm64') }), /wrong architecture/);
});

test('build refuses to stamp a manifest when a source changes during the build', () => {
  const { probe, buildSh, body, out } = fixture('darwin-arm64');
  fs.writeFileSync(buildSh, `${body}\nprintf changed >> "$(dirname "$0")/src/frame_protocol.h"\n`);
  assert.throws(() => prep.buildTarget('darwin-arm64', { probeDir: probe, out, nativeVerifier: () => nativeFor('arm64') }), /build inputs changed during build/);
  assert.equal(fs.existsSync(path.join(out, 'build-manifest.json')), false);
});

test('prepare script stays within the 200-line budget', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prepare-syphon.cjs'), 'utf8').trimEnd().split('\n').length;
  assert.ok(lines <= 200, `${lines} lines`);
});

test('cli selection: both by default, explicit target, conflicting arch rejected', () => {
  assert.deepEqual(prep.targetsFor(prep.parseArgs([])), ['darwin-arm64', 'darwin-x64']);
  assert.deepEqual(prep.targetsFor(prep.parseArgs(['--arch', 'arm64'])), ['darwin-arm64']);
  assert.deepEqual(prep.targetsFor(prep.parseArgs(['--target=darwin-x64'])), ['darwin-x64']);
  assert.throws(() => prep.targetsFor(prep.parseArgs(['--arch', 'arm64', '--target', 'darwin-x64'])), /conflicts/);
  assert.throws(() => prep.parseArgs(['--bogus']), /unknown option/);
});
