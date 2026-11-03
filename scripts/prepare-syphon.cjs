#!/usr/bin/env node
'use strict';
// Sequential packaging build/verification for the native Syphon bundle.
// Never downloads; never claims Intel runtime coverage from a cross-compile.
// Manifests are written only after lipo/otool checks; --verify-only never writes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const REPO_ROOT = path.resolve(__dirname, '..');
const PROBE_DIR = path.join(REPO_ROOT, 'native', 'syphon-probe');
const BUILD_ROOT = path.join(PROBE_DIR, 'build');
const MANIFEST = 'build-manifest.json';
const HOST = process.arch === 'x64' ? 'x86_64' : process.arch;
const TARGETS = { arm64: 'darwin-arm64', x86_64: 'darwin-x64' };
const ARCHES = { 'darwin-arm64': 'arm64', 'darwin-x64': 'x86_64' };
const ARTIFACTS = [{ path: 'Syphon.framework/Versions/A/Syphon', kind: 'framework' }, { path: 'libcuedeck_syphon_gpu.dylib', kind: 'dylib' }, ...['SyphonMetalShaders.metal', 'SyphonServerMetalTypes.h', 'Info.plist', 'License.txt'].map((name) => ({ path: `Syphon.framework/Versions/A/Resources/${name}` }))];
class CliError extends Error {}
const fail = (message) => { throw new CliError(message); };
function usage() {
  return `Usage: node scripts/prepare-syphon.cjs [--arch arm64|x86_64|all] [--target darwin-arm64|darwin-x64] [--verify-only]\nBuilds both targets sequentially in native/syphon-probe/build/<target>/ with Syphon.framework, libcuedeck_syphon_gpu.dylib and build-manifest.json.\n--verify-only checks inputs, manifest, artifact hashes, lipo archs, install names and the @rpath Syphon dependency; it never writes.\nRuntime is NOT verified, and an x86_64 cross-build is not Intel runtime coverage.`;
}
function parseArgs(argv) {
  const opts = { verifyOnly: false, help: false, arch: null, target: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verify-only') opts.verifyOnly = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else {
      const match = /^--(arch|target)(?:=(.*))?$/.exec(arg);
      if (!match) fail(`unknown option: ${arg}`);
      const value = match[2] !== undefined ? match[2] : argv[++i];
      if (value === undefined || value === '') fail(`missing value for --${match[1]}`);
      opts[match[1]] = value;
    }
  }
  return opts;
}
function normalizeArch(value) {
  if (value === 'x64' || value === 'x86_64') return 'x86_64';
  if (value === 'arm64') return 'arm64';
  fail(`unsupported architecture: ${value}`);
}
function targetsFor(opts) {
  if (opts.target) {
    if (!ARCHES[opts.target]) fail(`unsupported target: ${opts.target}`);
    if (opts.arch && ARCHES[opts.target] !== normalizeArch(opts.arch)) fail(`--arch ${opts.arch} conflicts with --target ${opts.target}`);
    return [opts.target];
  }
  if (!opts.arch || opts.arch === 'all' || opts.arch === 'both') return ['darwin-arm64', 'darwin-x64'];
  return [TARGETS[normalizeArch(opts.arch)]];
}
function readPins(probeDir = PROBE_DIR) {
  let text;
  try { text = fs.readFileSync(path.join(probeDir, 'build.sh'), 'utf8'); } catch { fail(`build.sh missing: ${path.join(probeDir, 'build.sh')}`); }
  const commit = /^SYPHON_COMMIT="([0-9a-f]{40})"$/m.exec(text);
  const sha256 = /^SYPHON_SHA256="([0-9a-f]{64})"$/m.exec(text);
  const min = /^MIN_MACOS="([0-9.]+)"$/m.exec(text);
  if (!commit || !sha256) fail('build.sh does not declare a pinned Syphon commit/SHA');
  return { commit: commit[1], sha256: sha256[1], minMacos: min ? min[1] : '13.0' };
}
function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (error) { fail(`cannot read ${file}: ${error.message}`); }
}
function collectInputs(probeDir, pins) {
  const srcDir = path.join(probeDir, 'src');
  const sources = fs.readdirSync(srcDir).filter((f) => /\.(m|mm|c|h)$/.test(f)).sort();
  const files = [
    ['build.sh', path.join(probeDir, 'build.sh')],
    ['patches/syphon-metal-runtime-library.patch', path.join(probeDir, 'patches', 'syphon-metal-runtime-library.patch')],
    [`vendor/syphon-framework-${pins.commit}.tar.gz`, path.join(probeDir, 'vendor', `syphon-framework-${pins.commit}.tar.gz`)],
    ...sources.map((f) => [`src/${f}`, path.join(srcDir, f)]),
  ];
  const inputs = files.map(([rel, abs]) => {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(`build input missing: ${abs}`);
    return { path: rel, sha256: sha256File(abs) };
  });
  const tarball = inputs.find((i) => i.path.startsWith('vendor/'));
  if (tarball.sha256 !== pins.sha256) fail(`Syphon source SHA-256 mismatch: expected ${pins.sha256}, got ${tarball.sha256}`);
  return inputs;
}
function hashInputs(inputs) {
  return crypto.createHash('sha256').update(inputs.map((i) => `${i.path}\0${i.sha256}\n`).join('')).digest('hex');
}
function validateOutputDir(probeDir, outputDir) {
  const allowed = path.resolve(probeDir, 'build');
  const raw = path.resolve(probeDir, outputDir);
  if (raw === path.parse(raw).root || raw === probeDir || raw === path.dirname(probeDir)) fail(`unsafe output directory: ${raw}`);
  if (raw !== allowed && !raw.startsWith(`${allowed}${path.sep}`)) fail(`output must be under ${allowed}: ${raw}`);
  let cur = allowed;
  for (const part of ['.', ...path.relative(allowed, raw).split(path.sep).filter(Boolean)]) {
    cur = part === '.' ? allowed : path.join(cur, part);
    let stat;
    try { stat = fs.lstatSync(cur); } catch { continue; }
    if (stat.isSymbolicLink()) fail(`refusing symlink in output path: ${cur}`);
  }
  if (fs.existsSync(raw) && !fs.statSync(raw).isDirectory()) fail(`output is not a directory: ${raw}`);
  return raw;
}
function run(file, args) {
  try { return execFileSync(file, args, { encoding: 'utf8' }); }
  catch (error) { fail(`${path.basename(file)} failed: ${error.stderr || error.message}`); }
}
const lines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);
const archsOf = (file) => lines(run('/usr/bin/lipo', ['-archs', file])).join(' ').split(/\s+/).filter(Boolean);
const installNameOf = (file) => lines(run('/usr/bin/otool', ['-D', file]))[1] || '';
const depsOf = (file) => lines(run('/usr/bin/otool', ['-L', file])).slice(1).map((l) => l.replace(/\s+\(.*$/, ''));
function checkArch(file, expected) {
  const actual = archsOf(file);
  if (actual.length !== 1 || actual[0] !== expected) fail(`wrong architecture for ${file}: expected ${expected}, got ${actual.join(',') || 'none'}`);
  return actual;
}
function verifyNative(out, arch) {
  const fw = path.join(out, 'Syphon.framework');
  const fwBin = path.join(fw, 'Versions', 'A', 'Syphon');
  const dylib = path.join(out, 'libcuedeck_syphon_gpu.dylib');
  for (const file of [fwBin, dylib]) if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`missing artifact: ${file}`);
  const archs = { framework: checkArch(fwBin, arch), dylib: checkArch(dylib, arch) };
  const installNames = { framework: installNameOf(fwBin), dylib: installNameOf(dylib) };
  if (installNames.framework !== '@rpath/Syphon.framework/Versions/A/Syphon') fail(`wrong framework install name: ${installNames.framework}`);
  if (installNames.dylib !== '@rpath/libcuedeck_syphon_gpu.dylib') fail(`wrong dylib install name: ${installNames.dylib}`);
  const frameworkDependency = '@rpath/Syphon.framework/Versions/A/Syphon';
  const deps = depsOf(dylib);
  if (!deps.includes(frameworkDependency)) fail(`missing framework dependency ${frameworkDependency} in dylib`);
  const bad = deps.find((d) => d.includes('/Syphon.framework/') && !d.startsWith('@rpath/'));
  if (bad) fail(`framework dependency is not @rpath: ${bad}`);
  return { archs, installNames, frameworkDependency };
}
function createManifest(out, target, arch, pins, inputs, native) {
  return {
    schema: 1, target, arch, syphonCommit: pins.commit, minMacos: pins.minMacos, inputSha256: hashInputs(inputs), inputs,
    artifacts: ARTIFACTS.map((a) => ({ path: a.path, sha256: sha256File(path.join(out, a.path)), ...(a.kind ? { archs: native.archs[a.kind], installName: native.installNames[a.kind] } : {}) })),
    frameworkDependency: native.frameworkDependency, runtimeVerified: false, crossCompiled: HOST !== arch,
  };
}
function verifyManifest(target, out, opts = {}) {
  const probeDir = opts.probeDir || PROBE_DIR;
  const manifestPath = path.join(out, MANIFEST);
  if (!fs.existsSync(manifestPath)) fail(`manifest missing: ${manifestPath} (run a build first)`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (error) { fail(`manifest is not valid JSON: ${error.message}`); }
  if (!manifest || manifest.schema !== 1) fail(`unsupported manifest schema: ${manifest && manifest.schema}`);
  if (!Array.isArray(manifest.artifacts)) fail('manifest artifacts missing');
  const arch = ARCHES[target];
  if (manifest.target !== target || manifest.arch !== arch) fail(`manifest target mismatch: expected ${target}/${arch}`);
  const pins = readPins(probeDir);
  const inputs = collectInputs(probeDir, pins);
  if (manifest.inputSha256 !== hashInputs(inputs) || JSON.stringify(manifest.inputs) !== JSON.stringify(inputs)) fail('stale manifest: build inputs changed, rebuild required');
  for (const spec of ARTIFACTS) {
    const entry = (manifest.artifacts || []).find((a) => a.path === spec.path);
    if (!entry) fail(`manifest missing artifact: ${spec.path}`);
    const file = path.join(out, spec.path);
    if (!fs.existsSync(file)) fail(`missing artifact: ${file}`);
    if (sha256File(file) !== entry.sha256) fail(`stale artifact: SHA-256 mismatch for ${spec.path}`);
  }
  const native = (opts.nativeVerifier || verifyNative)(out, arch);
  for (const spec of ARTIFACTS) {
    if (!spec.kind) continue;
    const entry = manifest.artifacts.find((a) => a.path === spec.path);
    const actual = native.archs[spec.kind];
    if (!Array.isArray(entry.archs) || entry.archs.length !== 1 || entry.archs[0] !== arch) fail(`manifest wrong architecture for ${spec.path}: ${entry.archs}`);
    if (!Array.isArray(actual) || actual.length !== 1 || actual[0] !== arch) fail(`wrong architecture for ${spec.path}: expected ${arch}, got ${actual}`);
    if (entry.installName !== native.installNames[spec.kind]) fail(`install name mismatch for ${spec.path}`);
  }
  if (manifest.frameworkDependency !== native.frameworkDependency) fail('framework dependency mismatch');
  if (manifest.runtimeVerified !== false) fail('manifest must not claim runtime verification');
  return manifest;
}
function buildTarget(target, opts = {}) {
  if (!ARCHES[target]) fail(`unsupported target: ${target}`);
  const probeDir = opts.probeDir || PROBE_DIR;
  const out = validateOutputDir(probeDir, opts.out || path.join(BUILD_ROOT, target));
  const pins = readPins(probeDir);
  const inputs = collectInputs(probeDir, pins);
  fs.rmSync(path.join(out, MANIFEST), { force: true });
  execFileSync('/bin/bash', [path.join(probeDir, 'build.sh'), '--arch', ARCHES[target], '--output-dir', out], { stdio: 'inherit', cwd: probeDir });
  const native = (opts.nativeVerifier || verifyNative)(out, ARCHES[target]);
  const afterPins = readPins(probeDir), after = collectInputs(probeDir, afterPins);
  if (JSON.stringify(after) !== JSON.stringify(inputs) || JSON.stringify(afterPins) !== JSON.stringify(pins)) fail('build inputs changed during build; refusing manifest');
  const manifest = createManifest(out, target, ARCHES[target], pins, inputs, native);
  const final = path.join(out, MANIFEST), tmp = `${final}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, final);
  return manifest;
}
function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseArgs(argv); if (opts.help) { console.log(usage()); return; }
    for (const target of targetsFor(opts)) {
      const manifest = opts.verifyOnly ? verifyManifest(target, path.join(BUILD_ROOT, target)) : buildTarget(target);
      console.log(`${opts.verifyOnly ? 'verified' : 'built'} ${target} ${manifest.arch} input=${manifest.inputSha256.slice(0, 12)}`);
    }
  } catch (error) {
    console.error(`prepare-syphon: ${error.message}`); process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { CliError, TARGETS, ARCHES, ARTIFACTS, PROBE_DIR, BUILD_ROOT, parseArgs, targetsFor, readPins, collectInputs, hashInputs, validateOutputDir, verifyNative, createManifest, verifyManifest, buildTarget, main };
