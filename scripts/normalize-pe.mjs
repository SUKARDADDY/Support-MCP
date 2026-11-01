// Zero the fields of a .NET PE file that change between two builds of the same
// source, so two builds can be compared byte for byte.
//
// The .NET Framework v4 compiler (csc.exe) writes three build-specific values:
//   1. the COFF header TimeDateStamp,
//   2. the optional-header CheckSum (the compiler leaves it 0; zeroed so a
//      checksum fixed up by another tool cannot cause a mismatch), and
//   3. the module version id (MVID), the one GUID in the metadata #GUID heap
//      that the Module table row points at.
// Nothing else is touched. Every other byte, including code, metadata, resources
// and the embedded file name, must match for two normalized files to be equal.
//
//   node scripts/normalize-pe.mjs <file.exe>      print the SHA-256 of the normalized file
//   node scripts/normalize-pe.mjs --bundle <json> the same for exe_b64 in an app bundle
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const fail = message => { throw new Error(`Not a valid .NET PE file: ${message}`); };

function need(buffer, offset, length, what) {
  if (!Number.isInteger(offset) || offset < 0 || offset + length > buffer.length) fail(`${what} is outside the file`);
}

// Map a relative virtual address to a file offset through the section table.
function rvaToOffset(buffer, sections, rva, size, what) {
  for (const s of sections) {
    if (rva >= s.rva && rva + size <= s.rva + Math.max(s.virtualSize, s.rawSize)) {
      const offset = s.rawOffset + (rva - s.rva);
      need(buffer, offset, size, what);
      return offset;
    }
  }
  return fail(`${what} is not inside any section`);
}

// Returns { bytes, fields }. `bytes` is a normalized copy; `fields` lists what was zeroed.
export function normalizePe(input) {
  const bytes = Buffer.from(input);
  need(bytes, 0, 0x40, 'DOS header');
  if (bytes.readUInt16LE(0) !== 0x5a4d) fail('missing MZ signature');
  const pe = bytes.readUInt32LE(0x3c);
  need(bytes, pe, 24, 'PE header');
  if (bytes.readUInt32LE(pe) !== 0x4550) fail('missing PE signature');

  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const opt = pe + 24;
  need(bytes, opt, optionalSize, 'optional header');
  const magic = bytes.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) fail('unknown optional header magic');
  const dirCountAt = opt + (magic === 0x10b ? 92 : 108);
  const dirs = dirCountAt + 4;
  if (bytes.readUInt32LE(dirCountAt) < 15) fail('no CLR header directory');
  need(bytes, dirs + 14 * 8, 8, 'CLR header directory');

  const fields = [];
  const zero = (name, offset, length) => {
    need(bytes, offset, length, name);
    bytes.fill(0, offset, offset + length);
    fields.push({ name, offset, length });
  };
  zero('COFF TimeDateStamp', pe + 8, 4);
  zero('optional header CheckSum', opt + 64, 4);

  const sectionTable = opt + optionalSize;
  need(bytes, sectionTable, sectionCount * 40, 'section table');
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = sectionTable + i * 40;
    sections.push({ virtualSize: bytes.readUInt32LE(at + 8), rva: bytes.readUInt32LE(at + 12), rawSize: bytes.readUInt32LE(at + 16), rawOffset: bytes.readUInt32LE(at + 20) });
  }

  const cliRva = bytes.readUInt32LE(dirs + 14 * 8), cliSize = bytes.readUInt32LE(dirs + 14 * 8 + 4);
  if (!cliRva || cliSize < 16) fail('no CLR header');
  const cli = rvaToOffset(bytes, sections, cliRva, cliSize, 'CLR header');
  const metaRva = bytes.readUInt32LE(cli + 8), metaSize = bytes.readUInt32LE(cli + 12);
  const meta = rvaToOffset(bytes, sections, metaRva, metaSize, 'metadata');
  if (bytes.readUInt32LE(meta) !== 0x424a5342) fail('missing BSJB metadata signature');

  const versionLength = bytes.readUInt32LE(meta + 12);
  let at = meta + 16 + versionLength + 2; // skip the version string and the flags
  need(bytes, at, 2, 'stream count');
  const streamCount = bytes.readUInt16LE(at);
  at += 2;
  const streams = new Map();
  for (let i = 0; i < streamCount; i++) {
    need(bytes, at, 9, 'stream header');
    const offset = bytes.readUInt32LE(at), size = bytes.readUInt32LE(at + 4);
    let end = at + 8;
    while (end < bytes.length && bytes[end] !== 0) end++;
    need(bytes, end, 1, 'stream name');
    const name = bytes.toString('latin1', at + 8, end);
    if (offset + size > metaSize) fail(`stream ${name} runs past the metadata`);
    streams.set(name, { offset: meta + offset, size });
    at += 8 + Math.ceil((end - (at + 8) + 1) / 4) * 4; // the name and its null are padded to 4 bytes
  }

  const tables = streams.get('#~') ?? streams.get('#-');
  const guids = streams.get('#GUID');
  if (!tables || !guids) fail('missing #~ or #GUID stream');
  // Tables stream: 4 reserved, 2 version, HeapSizes, 1 reserved, Valid (8), Sorted (8), then row counts.
  need(bytes, tables.offset, 28, 'tables header');
  const heapSizes = bytes[tables.offset + 6];
  const valid = bytes.readBigUInt64LE(tables.offset + 8);
  if (!(valid & 1n)) fail('no Module table');
  let rowsAt = tables.offset + 24;
  for (let bit = 0n; bit < 64n; bit++) if (valid & (1n << bit)) rowsAt += 4;
  if (heapSizes & 0x40) rowsAt += 4; // extra data word
  // Module row: Generation (2), Name (#Strings index), Mvid (#GUID index), EncId, EncBaseId.
  const stringIndex = heapSizes & 1 ? 4 : 2, guidIndex = heapSizes & 2 ? 4 : 2;
  const mvidAt = rowsAt + 2 + stringIndex;
  need(bytes, mvidAt, guidIndex, 'Module row');
  const mvid = guidIndex === 4 ? bytes.readUInt32LE(mvidAt) : bytes.readUInt16LE(mvidAt);
  if (mvid < 1 || mvid * 16 > guids.size) fail('MVID index is outside the #GUID heap');
  zero('metadata MVID', guids.offset + (mvid - 1) * 16, 16);
  return { bytes, fields };
}

export const normalizedSha256 = input => createHash('sha256').update(normalizePe(input).bytes).digest('hex');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, file] = process.argv.slice(2);
  try {
    const exe = flag === '--bundle' && file ? Buffer.from(JSON.parse(readFileSync(file, 'utf8')).exe_b64, 'base64') : readFileSync(flag ?? '');
    console.log(normalizedSha256(exe));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
