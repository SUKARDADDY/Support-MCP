// Check that the executable committed in src/app-bundle.json is the build of the
// committed source. CI builds the app on Windows, then runs:
//   node scripts/verify-app-binary.mjs <fresh.exe> [src/app-bundle.json]
// Both files are normalized (see normalize-pe.mjs) and must then be identical.
import { readFileSync } from 'node:fs';
import { normalizedSha256 } from './normalize-pe.mjs';

const [freshPath, bundlePath = new URL('../src/app-bundle.json', import.meta.url)] = process.argv.slice(2);
if (!freshPath) {
  console.error('usage: node scripts/verify-app-binary.mjs <fresh.exe> [src/app-bundle.json]');
  process.exit(2);
}
const fresh = normalizedSha256(readFileSync(freshPath));
const committed = normalizedSha256(Buffer.from(JSON.parse(readFileSync(bundlePath, 'utf8')).exe_b64, 'base64'));
console.log(`fresh build, normalized:     ${fresh}`);
console.log(`committed exe, normalized:   ${committed}`);
if (fresh !== committed) {
  console.error('\nThe committed exe does not match the source: rebuild src/app-bundle.json with scripts/build-app.ps1 -ReferenceDir <4.5.2 references> on Windows (scripts/fetch-net452-refs.ps1 fetches them).');
  process.exit(1);
}
console.log('OK: the committed exe matches a fresh build of the committed source.');
