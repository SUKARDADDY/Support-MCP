// Makes the test vectors the Rust core checks itself against, from the relay's own code, so the two cannot drift.
// Run it from the repository root after a change to src/release.js or src/rules.js:
//   node mac-agent/core/tests/data/make-vectors.mjs
// It signs with a key made on the spot and thrown away: the project's release key is never here. The output is
// written to mac-agent/core/tests/data/vectors.json and committed.
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMacNote, compareVersions, parseMacNote, validVersion } from '../../../../src/release.js';
import { rulesTag } from '../../../../src/rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const xy = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
const signNote = (note) => sign('sha256', Buffer.from(note), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');

const base = { version: '1.2.3', sha256: 'ab'.repeat(32), size: 12_345_678, released: 1_794_000_000, url: 'https://github.com/SUKARDADDY/Support-MCP/releases/download/v1.2.3/Support-1.2.3.pkg' };
const note = buildMacNote(base);
const lines = note.split('\n');
const notes = {
  valid: note,
  prerelease: buildMacNote({ ...base, version: '2.0.0-rc.1', url: base.url.replaceAll('1.2.3', '2.0.0-rc.1') }),
  windows_header: note.replace('support-mcp-mac-release 1', 'support-mcp-release 1'),
  technician_header: note.replace('support-mcp-mac-release 1', 'support-mcp-technician-release 1'),
  five_lines: lines.filter((l) => !l.startsWith('url ')).join('\n'),
  no_final_lf: note.slice(0, -1),
  crlf: note.replaceAll('\n', '\r\n'),
  extra_line: `${note}extra 1\n`,
  swapped_lines: [lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n'),
  uppercase_hex: note.replace('ab'.repeat(32), 'AB'.repeat(32)),
  leading_zero_size: note.replace('size 12345678', 'size 012345678'),
  zero_size: note.replace('size 12345678', 'size 0'),
  size_over_40_mib: note.replace('size 12345678', 'size 41943041'),
  size_at_40_mib: note.replace('size 12345678', 'size 41943040'),
  bad_version: note.replace('version 1.2.3', 'version 1.2'),
  url_http: note.replace('url https://', 'url http://'),
  url_other_host: note.replace('github.com', 'example.com'),
  url_query: note.replace('.pkg', '.pkg?x=1'),
  url_fragment: note.replace('.pkg', '.pkg#x'),
  url_dotdot: note.replace('/releases/', '/../releases/'),
  url_space: note.replace('Support-1.2.3', 'Support 1.2.3'),
  url_too_long: note.replace('.pkg', `${'a'.repeat(300)}.pkg`),
  non_ascii: note.replace('Support-MCP', 'Suppört-MCP'),
  over_1024_bytes: note.replace('url ', `url https://github.com/${'a'.repeat(1100)}/`),
};
const signed = {};
for (const [name, text] of Object.entries(notes)) signed[name] = { note: text, signature: signNote(text), relay_accepts: parseMacNote(text) !== null };

const versions = ['1.0.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.1', '1.10.0', '1.2.0', '2.0.0', '2.0.0+build.5', '0.9.9'];
const sorted = [...versions].sort(compareVersions);
const strings = ['1.2.3', '1.2', '01.2.3', '1.02.3', '1.2.3-', '1.2.3-01', '1.2.3-0a', '1.2.3-a.b.1', '1.2.3-a..b', '1.2.3+001', '1.2.3+', '1.2.3+a..b', '1.2.3+a+b', 'v1.2.3', '1.2.3 ', '', 'x', '1.2.3-rc.1+build.7', '1'.repeat(33) + '.0.0', '1.2.3-' + 'a'.repeat(30), '1.2.3-a_b'];
const validity = strings.map((s) => [s, validVersion(s)]);

const docs = JSON.parse(readFileSync(join(here, '../../../../test/fixtures/rules-cases.json'), 'utf8'));
const seen = new Set();
const tags = [];
for (const c of [...docs.decide, ...docs.decide_posix]) {
  const key = JSON.stringify(c.rules);
  if (seen.has(key)) continue;
  seen.add(key);
  tags.push({ doc: c.rules, tag: await rulesTag(c.rules) });
}
// A document with characters the canonical JSON has to escape the way JSON.stringify does.
const odd = { rev: 3, time_zone: null, hours: null, restart: 'allow', shutdown: 'never', install: 'approve', uninstall: 'approve', close_program: 'allow',
  protected_programs: ['Café "Bar"', 'tab\there', 'emoji \u{1F600}', 'back\\slash'], protected_folders: ['/Users/a/Docs & <Stuff>', '/Volumes/Über'] };
tags.push({ doc: odd, tag: await rulesTag(odd) });

writeFileSync(join(here, 'vectors.json'), `${JSON.stringify({ public_key_xy_b64: xy, notes: signed, versions: { sorted, validity }, tags }, null, 1)}\n`);
console.log('wrote vectors.json:', Object.keys(signed).length, 'notes,', tags.length, 'tags');
