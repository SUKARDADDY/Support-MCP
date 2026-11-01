// Build the PowerShell one-liner target served at GET /j/<code>.
//
// The served script IS agent.ps1 with placeholders substituted, wrapped in
// `& { ... }` so `irm | iex` runs it in a child scope: none of its variables,
// functions or $ErrorActionPreference leak into the customer's console. It runs
// as the bootstrap role (no -Run), decodes the embedded base64 body to disk,
// launches that copy with -Run, and prints one line. The embedded copy has an
// empty {{AGENT_B64}} so there is no self-reference / recursion, and is not
// wrapped (it runs via -File).
//
// Every substituted value is hex / base32 / URL only and is validated here, so a
// single-quoted PowerShell literal ('<value>') can never be terminated early.

const HEX64 = /^[0-9a-f]{64}$/;
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

export function validateSid(sid) {
  if (!HEX64.test(String(sid))) throw new Error('bad sid');
  return sid;
}
export function validateKey(key) {
  if (!HEX64.test(String(key))) throw new Error('bad key');
  return key;
}
export function validateOrigin(origin) {
  if (!ORIGIN_RE.test(String(origin))) throw new Error('bad origin');
  return origin;
}

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// agentText: the raw src/agent.ps1 (with the four placeholders).
export function buildBootstrap(agentText, { sid, key, origin }) {
  validateSid(sid);
  validateKey(key);
  validateOrigin(origin);

  const subst = (t) =>
    t.replace(/\{\{SID\}\}/g, sid).replace(/\{\{KEY\}\}/g, key).replace(/\{\{ORIGIN\}\}/g, origin);

  // On-disk copy: same values, but no embedded body (it only ever runs -Run).
  const onDisk = subst(agentText).replace(/\{\{AGENT_B64\}\}/g, '');
  const b64 = b64utf8(onDisk);
  // Served copy: same values, embedded body = base64 of the on-disk copy.
  return '& {\n' + subst(agentText).replace(/\{\{AGENT_B64\}\}/g, b64) + '\n}\n';
}

// ---- Windows modes ----------------------------------------------------------
// `app` (the default): the customer downloads a session-specific .NET app that
// talks to the relay over HTTPS polling. `powershell`: the one-line paste.
// `legacy` and `standard` are accepted as aliases for `app` and `powershell`.
const WINDOWS_MODE_ALIASES = { app: 'app', legacy: 'app', powershell: 'powershell', standard: 'powershell' };

export function normalizeWindowsMode(mode) {
  const canonical = Object.prototype.hasOwnProperty.call(WINDOWS_MODE_ALIASES, mode) ? WINDOWS_MODE_ALIASES[mode] : undefined;
  if (!canonical) throw new Error('windows_mode must be app or powershell');
  return canonical;
}

// The `?client=` value on a /j link. Same names as windows_mode, same aliases.
export function clientMode(value) {
  return Object.prototype.hasOwnProperty.call(WINDOWS_MODE_ALIASES, value) && WINDOWS_MODE_ALIASES[value] === 'app' ? 'app' : null;
}

// The tail of every downloaded app: configuration JSON, its length as a
// little-endian uint32, then this magic string. The app reads it from its own file.
export const APP_CONFIG_FOOTER = 'SUPPORTMCPCFG1';

// A session-specific .NET executable: the shared bundle with only validated
// pairing configuration appended. The attach key never appears in a URL or argv.
export function buildAppDownload(bundle, { sid, key, origin, startup_expires_at }) {
  validateSid(sid);
  validateKey(key);
  validateOrigin(origin);
  if (!Number.isSafeInteger(startup_expires_at) || startup_expires_at <= 0) throw new Error('bad startup deadline');
  const binary = Uint8Array.from(atob(bundle.exe_b64), (c) => c.charCodeAt(0));
  if (binary[0] !== 77 || binary[1] !== 90) throw new Error('bad app executable');
  const config = new TextEncoder().encode(JSON.stringify({ sid, key, origin, startup_expires_at }));
  const footer = new TextEncoder().encode(APP_CONFIG_FOOTER);
  const out = new Uint8Array(binary.length + config.length + 4 + footer.length);
  out.set(binary);
  out.set(config, binary.length);
  new DataView(out.buffer).setUint32(binary.length + config.length, config.length, true);
  out.set(footer, binary.length + config.length + 4);
  return out;
}

export const INVALID_LINK_SCRIPT = "Write-Host 'This support link is invalid or expired.'\n";
export const METHOD_NOT_ALLOWED_SCRIPT = "Write-Host 'This support link only works with irm.'\n";
export const NOT_POWERSHELL_SCRIPT =
  "Write-Host 'This is a support link. Paste the whole command into PowerShell instead of opening the link.'\n";
export const USE_HTTPS_TEXT = 'This support link must use https. Open the link again with https:// at the start of the address.\n';
export const USE_HTTPS_SCRIPT =
  "Write-Host 'This support link must use https. Paste the command again with https:// at the start of the address.'\n";
