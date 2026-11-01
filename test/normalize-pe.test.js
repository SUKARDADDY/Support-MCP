// The PE normalizer behind the CI check that src/app-bundle.json holds the
// build of src/agent-app.cs. It must erase only the fields that differ between
// two builds of one source and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizePe, normalizedSha256 } from '../scripts/normalize-pe.mjs';

const bundle = JSON.parse(await readFile(new URL('../src/app-bundle.json', import.meta.url)));
const exe = Buffer.from(bundle.exe_b64, 'base64');

test('zeroes exactly the timestamp, checksum and MVID of the committed exe', () => {
  const { bytes, fields } = normalizePe(exe);
  assert.deepEqual(fields.map(f => f.name), ['COFF TimeDateStamp', 'optional header CheckSum', 'metadata MVID']);
  assert.deepEqual(fields.map(f => f.length), [4, 4, 16]);
  assert.equal(bytes.length, exe.length);
  const changed = new Set();
  for (let i = 0; i < exe.length; i++) if (exe[i] !== bytes[i]) changed.add(i);
  for (const { offset, length } of fields) {
    assert.ok(bytes.subarray(offset, offset + length).every(b => b === 0));
    for (let i = offset; i < offset + length; i++) changed.delete(i);
  }
  assert.equal(changed.size, 0, 'only the listed fields may change');
  assert.equal(exe.readUInt32LE(fields[0].offset) !== 0, true, 'the committed exe carries a build timestamp');
  assert.equal(exe.subarray(fields[2].offset, fields[2].offset + 16).some(b => b !== 0), true, 'the committed exe carries an MVID');
});

test('the MVID field is the metadata GUID the Module table points at', () => {
  const { fields } = normalizePe(exe);
  const guid = exe.subarray(fields[2].offset, fields[2].offset + 16);
  // csc writes a version 4 GUID: the high nibble of byte 7 is 4.
  assert.equal(guid[7] >> 4, 4);
  assert.equal(exe.indexOf(guid), fields[2].offset, 'the GUID appears once in the file');
});

test('builds that differ only in timestamp, checksum and MVID normalize to the same bytes', () => {
  const { fields } = normalizePe(exe);
  const other = Buffer.from(exe);
  for (const { offset, length } of fields) for (let i = 0; i < length; i++) other[offset + i] ^= 0xa5;
  assert.notDeepEqual(other, exe);
  assert.equal(normalizedSha256(other), normalizedSha256(exe));
});

test('normalizing twice changes nothing', () => {
  const once = normalizePe(exe).bytes;
  assert.deepEqual(normalizePe(once).bytes, once);
});

test('any other byte change alters the normalized hash', () => {
  const { fields } = normalizePe(exe);
  const skip = new Set();
  for (const { offset, length } of fields) for (let i = 0; i < length; i++) skip.add(offset + i);
  const base = normalizedSha256(exe);
  // Flip one byte in every 997th position: headers, code, metadata, resources and padding all count.
  let checked = 0;
  for (let i = 0; i < exe.length; i += 997) {
    if (skip.has(i)) continue;
    const tampered = Buffer.from(exe);
    tampered[i] ^= 1;
    // A flipped byte that breaks the parser also fails the check, so it counts as covered.
    let hash;
    try { hash = normalizedSha256(tampered); } catch { hash = 'rejected'; }
    assert.notEqual(hash, base, `byte ${i} must be covered`);
    checked++;
  }
  assert.ok(checked > 50);
  const appended = Buffer.concat([exe, Buffer.from([0])]);
  assert.notEqual(normalizedSha256(appended), base, 'appended data must be covered');
});

test('rejects input that is not a .NET PE file', () => {
  assert.throws(() => normalizePe(Buffer.alloc(10)), /Not a valid .NET PE file/);
  assert.throws(() => normalizePe(Buffer.from('not an exe'.repeat(20))), /missing MZ/);
  assert.throws(() => normalizePe(exe.subarray(0, 0x200)), /Not a valid .NET PE file/);
  const noPe = Buffer.from(exe);
  noPe.writeUInt32LE(0, exe.readUInt32LE(0x3c));
  assert.throws(() => normalizePe(noPe), /missing PE signature/);
  const noMeta = Buffer.from(exe);
  const pe = exe.readUInt32LE(0x3c);
  noMeta.writeUInt32LE(0, pe + 24 + 96 + 14 * 8); // clear the CLR header directory
  assert.throws(() => normalizePe(noMeta), /no CLR header/);
});
