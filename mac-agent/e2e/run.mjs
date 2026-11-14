// The Mac core's end-to-end run (docs/development.md, "Mac agent core"):
//
//   node mac-agent/e2e/run.mjs
//
// It builds `support-core-e2e`, starts the real relay (`wrangler dev` on loopback, local D1, DEV_SKIP_ACCESS=1),
// applies the migrations, adds the first member, seeds one rules row and makes a pairing code through the team API.
// The client pairs and checks in as active with a fake platform (commands run with `sh -c`, files are real, the screen
// is one fixed JPEG). Then this script does what a technician's AI does, over MCP on HTTP: device_connect, run,
// put_file and get_file of 1 MB, screenshot, the Mac's own refusals, a power action and session_end. Any failed check
// exits non-zero. The relay and the client are always stopped and the run's folder removed.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { freePort, prepareConfig, startRelay, wranglerRun } from './relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const agent = resolve(here, '..');
const checks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  checks.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n     ${String(detail).split('\n').join('\n     ')}`}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}

async function until(what, fn, ms = 60_000, step = 200) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

let relay = null;
let client = null;
let prepared = null;
let protectedDir = null;

async function main() {
  // 1. The client binary.
  const cargo = process.env.CARGO || 'cargo';
  const build = spawnSync(cargo, ['build', '--locked', '--bin', 'support-core-e2e'], { cwd: agent, stdio: 'inherit' });
  if (build.status !== 0) throw new Error('cargo build failed');
  const bin = join(agent, 'target', 'debug', 'support-core-e2e');

  // 2. The relay.
  prepared = prepareConfig(root);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  wranglerRun(prepared, ['d1', 'migrations', 'apply', 'support-mcp', '--local']);
  // Rules the Mac must read: a Mac folder under a temp folder the run owns, and a Windows folder the Mac must never get.
  protectedDir = join(tmpdir(), `support-mac-e2e-protected-${process.pid}`);
  mkdirSync(protectedDir, { recursive: true });
  const doc = {
    time_zone: null, hours: null, restart: 'allow', shutdown: 'never', install: 'approve', uninstall: 'approve', close_program: 'allow',
    protected_programs: ['Finder'], protected_folders: [protectedDir, 'C:\\E2E\\Data'],
  };
  wranglerRun(prepared, ['d1', 'execute', 'support-mcp', '--local', '--command',
    `INSERT INTO rules(workspace, customer_id, doc, rev, updated_at, updated_by) VALUES ('default', '', '${JSON.stringify(doc).replaceAll("'", "''")}', 1, ${Date.now()}, 'e2e')`]);
  relay = await startRelay(prepared, port);
  check('the relay answers /healthz on loopback', true);

  const api = async (path, body, method = 'POST') => {
    const r = await fetch(`${base}/api/v1/w/default${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
    return json;
  };
  await api('/members', { identity: 'local-dev', role_id: 'admin' });
  const { pairing } = await api('/pairing', {});
  check('a pairing code is made through the team API', /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(pairing.code));

  // 3. The client: pair, check in, doorbell.
  client = spawn(bin, ['--origin', base, '--code', pairing.code, '--control', 'full', '--max-seconds', '240'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const events = [];
  createInterface({ input: client.stdout }).on('line', (line) => {
    try { events.push(JSON.parse(line)); } catch (_) { console.log(`client: ${line}`); }
  });
  let exitCode = null;
  client.on('exit', (code) => { exitCode = code; });
  const event = (name, pred = () => true) => events.find((e) => e.event === name && pred(e));
  const paired = await until('the client to pair', () => event('paired') || event('error') || (exitCode !== null && { exit: exitCode }));
  check('the client pairs with the code and is active', paired.status === 'active', JSON.stringify(paired));
  const deviceId = paired.device_id;
  await until('the first check-in as active', () => event('state', (e) => e.state === 'active') || event('rules'));
  check('it checks in as active', !!event('rules'), JSON.stringify(events));
  const rules = event('rules');
  check('the rules tag the relay sent is the tag of the document the client read', rules.tag_matches === true, JSON.stringify(rules));
  check('a Mac gets only the Mac folders of the team rules', JSON.stringify(rules.folders) === JSON.stringify([protectedDir]), JSON.stringify(rules.folders));
  await until('the doorbell', () => event('doorbell'), 30_000);
  check('the doorbell connects', true);

  // 4. MCP over HTTP, as a technician's AI would.
  let rpcId = 0;
  const rpc = async (method, params) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    const text = await r.text();
    if (r.status !== 200) throw new Error(`MCP ${method} -> ${r.status} ${text}`);
    const body = JSON.parse(text);
    if (body.error) throw new Error(`MCP ${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  };
  const call = async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    const textPart = result.content.find((c) => c.type === 'text');
    let data = textPart ? textPart.text : '';
    try { data = JSON.parse(data); } catch (_) { /* plain text */ }
    return { data, isError: !!result.isError, image: result.content.find((c) => c.type === 'image') };
  };
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mac-e2e', version: '1' } });

  const list = await call('device_list');
  const mac = (list.data.devices ?? list.data).find((d) => d.id === deviceId);
  check('device_list shows the Mac as macOS, active, online and at the client version', !!mac && mac.os === 'macOS 26.1 (25B78)' && mac.status === 'active' && mac.online === true && mac.app_version === '1.0.0', JSON.stringify(mac));

  const connected = await call('device_connect', { device_id: deviceId });
  check('device_connect starts a session', !connected.isError && /^[0-9a-f]{64}$/.test(connected.data.session_id ?? ''), JSON.stringify(connected));
  const sid = connected.data.session_id;
  const attached = await until('the session to attach', async () => {
    const s = await call('session_status', { session_id: sid });
    return s.data.state === 'attached' ? s.data : s.data.state === 'ended' ? { ended: s.data } : null;
  }, 90_000, 500);
  check('the Mac picks the session up (ring, then check-in)', attached.state === 'attached', JSON.stringify(attached));
  check('the relay sees a Mac client with full control and the lanes', attached.control === 'full' && String(attached.client_agent ?? attached.agent ?? '').startsWith('macos-app-1') , JSON.stringify(attached));

  const ran = await call('run', { session_id: sid, command: 'echo hi' });
  check('run "echo hi" returns hi', ran.data.stdout?.trim() === 'hi' && ran.data.exit_code === 0, JSON.stringify(ran));

  const slow = call('run', { session_id: sid, command: 'sleep 4; echo slow-done', timeout_s: 30 });
  await sleep(1000);
  const during = await call('screenshot', { session_id: sid });
  check('a screenshot is served while a command is still running (two lanes)', !!during.image, JSON.stringify(during.data));
  const slowDone = await slow;
  check('and the long command still finishes', slowDone.data.stdout?.includes('slow-done'), JSON.stringify(slowDone));

  const timeout = await call('run', { session_id: sid, command: 'sleep 30', timeout_s: 1 });
  check('a command past its timeout is killed with no exit code', timeout.data.timed_out === true && timeout.data.exit_code === null, JSON.stringify(timeout));

  // 1 MB, in chunks that fit the relay's 700,000-character limit, back with the same SHA-256.
  const data = randomBytes(1024 * 1024);
  const want = createHash('sha256').update(data).digest('hex');
  const file = join(tmpdir(), `support-mac-e2e-file-${process.pid}.bin`);
  const CHUNK = 500_000;
  for (let off = 0; off < data.length; off += CHUNK) {
    const put = await call('put_file', { session_id: sid, path: file, data_b64: data.subarray(off, off + CHUNK).toString('base64'), append: off > 0 });
    if (put.isError || put.data.bytes !== Math.min(CHUNK, data.length - off)) throw new Error(`put_file failed: ${JSON.stringify(put)}`);
  }
  check('put_file writes 1 MB in chunks', true);
  const parts = [];
  for (let off = 0; ; off += 524_288) {
    const got = await call('get_file', { session_id: sid, path: file, offset: off });
    if (got.isError) throw new Error(`get_file failed: ${JSON.stringify(got)}`);
    parts.push(Buffer.from(got.data.data_b64, 'base64'));
    if (got.data.eof) break;
  }
  const back = Buffer.concat(parts);
  check('get_file reads it back with the same SHA-256', back.length === data.length && createHash('sha256').update(back).digest('hex') === want, `${back.length} bytes`);
  rmSync(file, { force: true });

  const shot = await call('screenshot', { session_id: sid });
  const known = readFileSync(join(agent, 'core', 'src', 'fake-screen.jpg'));
  check('screenshot returns the fake screen\'s known image', !!shot.image && shot.image.mimeType === 'image/jpeg' && Buffer.from(shot.image.data, 'base64').equals(known), JSON.stringify(shot.data));
  check('and says it is 1280 x 800, one display', shot.data.width === 1280 && shot.data.height === 800 && shot.data.displays === 1, JSON.stringify(shot.data));

  // The Mac's own refusals (docs/relay-v1-spec.md, "A Mac on the wire").
  const sas = await call('send_sas', { session_id: sid });
  check('send_sas is refused by the Mac', JSON.stringify(sas).includes('send_sas is not available on a Mac'), JSON.stringify(sas));
  const block = await call('block_input', { session_id: sid, on: true });
  check('block_input is refused by the Mac', JSON.stringify(block).includes('block_input is not available on a Mac'), JSON.stringify(block));
  const cad = await call('press_key', { session_id: sid, keys: 'ctrl+alt+Delete' });
  check('ctrl+alt+Delete is refused by the Mac', JSON.stringify(cad).includes('Ctrl+Alt+Del is not available on a Mac.'), JSON.stringify(cad));
  const full = await call('request_full_control', { session_id: sid });
  check('request_full_control is refused by the Mac', JSON.stringify(full).includes('full control is chosen when Support is set up on this Mac'), JSON.stringify(full));

  // The rules, on the Mac: restart is allowed by the seeded rules and the fake platform records it; a command that
  // restarts is sent to the tool; a link into a protected folder is caught by the Mac though the relay sees only the
  // path as written.
  const restart = await call('restart_pc', { session_id: sid, delay_s: 5 });
  check('restart_pc, allowed by the rules, goes through the Mac\'s own check', !restart.isError && Number.isInteger(restart.data.at), JSON.stringify(restart));
  // The seeded rules say shutdown is never. The command only echoes the words, so nothing real can happen if the
  // screen let it through.
  const raw = await call('run', { session_id: sid, command: 'echo shutdown -h now' });
  check('a raw command that names the shutdown verb is sent to the tool by the Mac\'s screen (use_tool)', JSON.stringify(raw).includes('use_tool'), JSON.stringify(raw));
  const link = join(tmpdir(), `support-mac-e2e-link-${process.pid}`);
  symlinkSync(protectedDir, link);
  const viaLink = await call('put_file', { session_id: sid, path: join(link, 'x.txt'), data_b64: Buffer.from('x').toString('base64') });
  check('a file through a link into a protected folder is refused by the Mac', JSON.stringify(viaLink).includes('protected_folder') && !existsSync(join(protectedDir, 'x.txt')), JSON.stringify(viaLink));
  rmSync(link, { force: true });
  const direct = await call('put_file', { session_id: sid, path: join(protectedDir, 'x.txt'), data_b64: Buffer.from('x').toString('base64') });
  check('and the same path as written is refused by the relay first', JSON.stringify(direct).includes('protected_folder'), JSON.stringify(direct));
  const programs = await call('list_programs', { session_id: sid });
  check('list_programs answers (the Mac is at least 1.0.0)', !programs.isError && Array.isArray(programs.data.running), JSON.stringify(programs));

  // End.
  const ended = await call('session_end', { session_id: sid });
  check('session_end ends the session', !ended.isError, JSON.stringify(ended));
  const status = await call('session_status', { session_id: sid });
  check('and the relay says it ended', status.data.state === 'ended', JSON.stringify(status.data));
  await until('the client to see the end', () => event('session_ended') || exitCode !== null, 30_000);
  check('the client saw the session end', !!event('session_ended'));
  await until('the client to exit', () => exitCode !== null, 30_000);
  check('and exits cleanly', exitCode === 0, `exit ${exitCode}`);
}

async function cleanup() {
  if (client && client.exitCode === null) client.kill('SIGKILL');
  if (relay) relay.stop();
  await sleep(500);
  if (prepared) prepared.cleanup();
  if (protectedDir) rmSync(protectedDir, { recursive: true, force: true });
}

let failed = false;
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
try {
  await main();
} catch (e) {
  failed = true;
  console.error(`\nFAILED: ${e.message}`);
} finally {
  await cleanup();
}
const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed} of ${checks.length} checks passed${failed ? ', then one failed' : ''}`);
process.exit(failed ? 1 : 0);
