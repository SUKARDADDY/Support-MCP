// Set the one release version in every file that carries a copy of it.
//
//   node scripts/bump-version.mjs <x.y.z>            e.g. 0.3.0, or 0.3.0-rc.1
//   node scripts/bump-version.mjs <x.y.z> --root <d> work on the files under <d> instead of the repo
//
// It rewrites package.json, package-lock.json (top level and packages[""]), src/version.js,
// src/agent.ps1, and src/agent-app.cs (Wire.Version and the four assembly attributes). The
// assembly and file versions are x.y.z.0: a prerelease or build part is dropped from them.
// A pattern that matches zero times or more than once is an error, and then no file is written.
// Every new file is computed before the first write. The writes themselves are not atomic: an I/O
// error midway can leave some files rewritten, and `git status` shows which.
// It does not write the CHANGELOG entry or rebuild src/app-bundle.json (see docs/development.md).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION_PATTERN } from '../src/version.js';

// The assembly attributes take four parts of 0 to 65534 each.
const MAX_PART = 65534;

const fail = (message) => {
  console.error(`bump-version: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootAt = args.indexOf('--root');
if (rootAt >= 0) {
  if (!args[rootAt + 1]) fail('--root needs a folder');
  root = resolve(args[rootAt + 1]);
  args.splice(rootAt, 2);
}
if (args.length !== 1) fail('usage: node scripts/bump-version.mjs <x.y.z> [--root <folder>]');
const version = args[0];
if (version.length > 32 || !VERSION_PATTERN.test(version)) fail(`"${version}" is not a version like 1.2.3 or 1.2.3-rc.1`);
const core = version.split(/[-+]/)[0];
if (core.split('.').some((part) => Number(part) > MAX_PART)) fail(`"${version}": each of x, y and z must be ${MAX_PART} or less`);
const assemblyVersion = `${core}.0`;

// One edit: `pattern` must match exactly once and `$1` / `$2` keep the text around the number.
const edit = (pattern, value) => ({ pattern, value });
const FILES = {
  'package.json': [edit(/^(  "version": ")[^"]*(",)$/gm, version)],
  'package-lock.json': [
    edit(/^(  "version": ")[^"]*(",)$/gm, version),
    edit(/("": \{\s*"name": "support-mcp",\s*"version": ")[^"]*(")/g, version),
  ],
  'src/version.js': [edit(/^(export const VERSION = ')[^']*(';)$/gm, version)],
  'src/agent.ps1': [edit(/(agent = '1'; version = ')[^']*(')/g, version)],
  'src/agent-app.cs': [
    edit(/(public const string Version = ")[^"]*(";)/g, version),
    edit(/(\[assembly: System\.Reflection\.AssemblyVersion\(")[^"]*("\)\])/g, assemblyVersion),
    edit(/(\[assembly: System\.Reflection\.AssemblyFileVersion\(")[^"]*("\)\])/g, assemblyVersion),
    edit(/(\[assembly: System\.Reflection\.AssemblyInformationalVersion\(")[^"]*("\)\])/g, version),
  ],
};

// Compute every new file first, so a failed pattern leaves the tree untouched.
const out = {};
for (const [file, edits] of Object.entries(FILES)) {
  let text;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch (e) {
    fail(`cannot read ${file}: ${e.message}`);
  }
  for (const { pattern, value } of edits) {
    const found = text.match(pattern)?.length ?? 0;
    if (found !== 1) fail(`${file}: expected one match for ${pattern}, found ${found}`);
    text = text.replace(pattern, (_, before, after) => `${before}${value}${after}`);
  }
  out[file] = text;
}
for (const [file, text] of Object.entries(out)) writeFileSync(join(root, file), text);

console.log(`Set the version to ${version} in ${Object.keys(out).join(', ')}.`);
console.log('Next: add a "## [' + version + ']" entry to CHANGELOG.md and rebuild src/app-bundle.json on Windows (scripts/build-app.ps1).');
