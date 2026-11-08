// Make the project's release key: an ECDSA P-256 key pair, created in memory.
//
//   node scripts/release-key.mjs <public key file> | <store the private key>
//
// It writes the private key (PKCS#8 PEM) to stdout only, for a pipe into a
// secrets manager, and never to a file. It writes the public key, the 64-byte
// X||Y in standard base64 on one line, to the file named on the command line
// (release-key.pub at the repo root). The public key also goes into the app as
// ReleaseKey.ProjectKey in src/agent-app.cs; test/release.test.js checks the two
// are equal. See docs/development.md, "Releases".
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const fail = (message) => {
  console.error(`release-key: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
if (args.length !== 1 || args[0].startsWith('-')) fail('usage: node scripts/release-key.mjs <public key file> | <store the private key>');
// A terminal would show the private key on screen and in its scrollback.
if (process.stdout.isTTY) fail('stdout is a terminal: pipe it into your secrets manager instead');

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const xy = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
if (xy.length !== 64) fail('unexpected public key size');
writeFileSync(args[0], `${xy.toString('base64')}\n`);
process.stdout.write(privateKey.export({ format: 'pem', type: 'pkcs8' }));
console.error(`release-key: wrote the public key to ${args[0]}. Put the same line in ReleaseKey.ProjectKey in src/agent-app.cs.`);
