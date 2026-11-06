// One release version lives in several files. This fails when they disagree, and
// checks that scripts/bump-version.mjs moves all of them together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION_PATTERN } from '../src/version.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'bump-version.mjs');
const FILES = ['package.json', 'package-lock.json', 'src/version.js', 'src/agent.ps1', 'src/agent-app.cs'];
const read = (root, file) => readFileSync(join(root, file), 'utf8');

// Every copy of the version in a tree, in the shape it is written there.
function versions(root) {
  const pkg = JSON.parse(read(root, 'package.json'));
  const lock = JSON.parse(read(root, 'package-lock.json'));
  const one = (file, re) => {
    const m = read(root, file).match(re);
    assert.ok(m, `${file} has no match for ${re}`);
    return m[1];
  };
  const asm = (name) => one('src/agent-app.cs', new RegExp(`\\[assembly: System\\.Reflection\\.${name}\\("([^"]*)"\\)\\]`));
  return {
    package: pkg.version,
    lock: lock.version,
    lockRoot: lock.packages[''].version,
    version_js: one('src/version.js', /VERSION = '([^']*)'/),
    ps1: one('src/agent.ps1', /agent = '1'; version = '([^']*)'/),
    cs_const: one('src/agent-app.cs', /public const string Version = "([^"]*)"/),
    cs_informational: asm('AssemblyInformationalVersion'),
    cs_assembly: asm('AssemblyVersion'),
    cs_file: asm('AssemblyFileVersion'),
  };
}

function copyTree() {
  const dir = mkdtempSync(join(tmpdir(), 'support-mcp-version-'));
  for (const file of FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(ROOT, file), join(dir, file));
  }
  return dir;
}

const bump = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' });
const snapshot = (dir) => Object.fromEntries(FILES.map((f) => [f, read(dir, f)]));

test('every copy of the version equals package.json', () => {
  const v = versions(ROOT);
  const want = v.package;
  assert.match(want, /^\d+\.\d+\.\d+/);
  const core = want.split(/[-+]/)[0];
  assert.deepEqual(v, {
    package: want, lock: want, lockRoot: want, version_js: want, ps1: want,
    cs_const: want, cs_informational: want, cs_assembly: `${core}.0`, cs_file: `${core}.0`,
  });
});

test('bump-version.mjs rewrites every copy, and a prerelease keeps x.y.z.0 for the assembly', () => {
  const dir = copyTree();
  try {
    const run = bump(dir, '0.3.0-rc.1');
    assert.equal(run.status, 0, run.stderr);
    const v = versions(dir);
    assert.deepEqual(v, {
      package: '0.3.0-rc.1', lock: '0.3.0-rc.1', lockRoot: '0.3.0-rc.1', version_js: '0.3.0-rc.1', ps1: '0.3.0-rc.1',
      cs_const: '0.3.0-rc.1', cs_informational: '0.3.0-rc.1', cs_assembly: '0.3.0.0', cs_file: '0.3.0.0',
    });
    for (const file of FILES) assert.notEqual(read(dir, file), read(ROOT, file), `${file} changed`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the version pattern follows SemVer for prerelease and build identifiers', () => {
  for (const good of ['0.2.0', '1.2.3-0', '1.2.3-0a', '1.2.3--', '1.2.3-rc.1', '1.2.3-alpha.0.x', '1.2.3+01', '1.2.3-rc.1+build.001']) {
    assert.ok(VERSION_PATTERN.test(good), `${good} is accepted`);
  }
  for (const bad of ['1.2.3-01', '1.2.3-rc.01', '1.2.3-00', '1.2.3-1.02', '01.2.3', '1.2.3-', '1.2.3+']) {
    assert.ok(!VERSION_PATTERN.test(bad), `${bad} is refused`);
  }
});

test('bump-version.mjs refuses a bad version and touches no file', () => {
  const dir = copyTree();
  try {
    const before = snapshot(dir);
    const refused = [
      'nope', '1.2', 'v1.2.3', '1.2.3 ', '1.2.3-', `1.2.3-${'a'.repeat(40)}`,
      '65535.0.0', '0.65535.0', '0.0.65535', '01.2.3', '1.02.3', '1.2.03', '1.2.3-..', '1.2.3-a..b', '1.2.3+a+b', '1.2.3+',
      '1.2.3-01', '1.2.3-rc.01', '1.2.3-00',
    ];
    for (const bad of refused) {
      const run = bump(dir, bad);
      assert.notEqual(run.status, 0, `${bad} is refused`);
      assert.match(run.stderr, /bump-version/);
    }
    assert.notEqual(bump(dir).status, 0, 'no version');
    assert.deepEqual(snapshot(dir), before);
    assert.equal(bump(dir, '65534.65534.65534').status, 0, 'the largest assembly version is accepted');
    assert.equal(versions(dir).cs_assembly, '65534.65534.65534.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version.mjs fails loudly when a pattern matches nothing, and writes nothing', () => {
  const dir = copyTree();
  try {
    writeFileSync(join(dir, 'src/agent.ps1'), read(dir, 'src/agent.ps1').replace("version = '", "ver = '"));
    const before = snapshot(dir);
    const run = bump(dir, '0.9.0');
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /agent\.ps1: expected one match.*found 0/);
    assert.deepEqual(snapshot(dir), before);
    // A second copy of the same line is as bad as none.
    writeFileSync(join(dir, 'src/agent.ps1'), `${read(dir, 'src/agent.ps1').replace('ver = ', 'version = ')}\n${"# agent = '1'; version = '0.2.0'"}\n`);
    const twice = bump(dir, '0.9.0');
    assert.notEqual(twice.status, 0);
    assert.match(twice.stderr, /found 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version.mjs with the current version changes nothing', () => {
  const dir = copyTree();
  try {
    const before = snapshot(dir);
    execFileSync(process.execPath, [SCRIPT, '--root', dir, versions(ROOT).package]);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
