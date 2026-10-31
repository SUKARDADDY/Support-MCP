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

export const INVALID_LINK_SCRIPT = "Write-Host 'This support link is invalid or expired.'\n";
export const METHOD_NOT_ALLOWED_SCRIPT = "Write-Host 'This support link only works with irm.'\n";
export const NOT_POWERSHELL_SCRIPT =
  "Write-Host 'This is a support link. Paste the whole command into PowerShell instead of opening the link.'\n";
export const USE_HTTPS_SCRIPT =
  "Write-Host 'This support link must use https. Paste the command again with https:// at the start of the address.'\n";
