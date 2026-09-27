import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBootstrap, validateSid, validateKey, validateOrigin, INVALID_LINK_SCRIPT } from '../src/template.js';

const SID = 'a'.repeat(64);
const KEY = 'b'.repeat(64);
const ORIGIN = 'http://localhost:8787';

const AGENT = [
  "$Sid = '{{SID}}'",
  "$Key = '{{KEY}}'",
  "$Origin = '{{ORIGIN}}'",
  "$AgentB64 = '{{AGENT_B64}}'",
  '# body',
].join('\n');

test('validators accept good values, reject bad', () => {
  assert.equal(validateSid(SID), SID);
  assert.equal(validateKey(KEY), KEY);
  assert.equal(validateOrigin(ORIGIN), ORIGIN);
  assert.equal(validateOrigin('https://support.example.com'), 'https://support.example.com');
  assert.throws(() => validateSid('xyz'));
  assert.throws(() => validateKey("a'; rm -rf /"));
  assert.throws(() => validateOrigin("http://x'evil"));
  assert.throws(() => validateOrigin('ftp://x'));
});

test('buildBootstrap substitutes values and embeds a non-empty body', () => {
  const out = buildBootstrap(AGENT, { sid: SID, key: KEY, origin: ORIGIN });
  assert.match(out, new RegExp(`\\$Sid = '${SID}'`));
  assert.match(out, new RegExp(`\\$Key = '${KEY}'`));
  assert.match(out, /\$Origin = 'http:\/\/localhost:8787'/);
  // AGENT_B64 replaced by real base64 (no placeholder left)
  assert.doesNotMatch(out, /\{\{AGENT_B64\}\}/);
  assert.match(out, /\$AgentB64 = '[A-Za-z0-9+/=]+'/);
});

test('embedded on-disk copy has empty AgentB64 (no recursion) but real sid/key', () => {
  const out = buildBootstrap(AGENT, { sid: SID, key: KEY, origin: ORIGIN });
  const m = out.match(/\$AgentB64 = '([A-Za-z0-9+/=]+)'/);
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  assert.match(decoded, new RegExp(`\\$Sid = '${SID}'`));
  assert.match(decoded, /\$AgentB64 = ''/); // inner copy carries no body
});

test('no placeholders remain in served script', () => {
  const out = buildBootstrap(AGENT, { sid: SID, key: KEY, origin: ORIGIN });
  assert.doesNotMatch(out, /\{\{(SID|KEY|ORIGIN|AGENT_B64)\}\}/);
});

test('bad values throw before any substitution', () => {
  assert.throws(() => buildBootstrap(AGENT, { sid: 'bad', key: KEY, origin: ORIGIN }), /bad sid/);
});

test('invalid-link script is the harmless runnable one', () => {
  assert.match(INVALID_LINK_SCRIPT, /Write-Host 'This support link is invalid or expired\.'/);
});

test('served script is wrapped in & { } so nothing leaks into the console', () => {
  const out = buildBootstrap(AGENT, { sid: SID, key: KEY, origin: ORIGIN });
  assert.ok(out.startsWith('& {\n'));
  assert.ok(out.endsWith('\n}\n'));
  const m = out.match(/\$AgentB64 = '([A-Za-z0-9+/=]+)'/);
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  assert.ok(!decoded.startsWith('& {'), 'on-disk copy runs via -File, not wrapped');
});
