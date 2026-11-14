// The Mac core's end-to-end run (docs/development.md, "Mac agent core"):
//
//   node mac-agent/e2e/run.mjs
//
// It builds `support-core-e2e`, starts the real relay (`wrangler dev` on loopback, local D1, DEV_SKIP_ACCESS=1),
// applies the migrations, adds the first member, seeds one rules row and makes a pairing code through the team API.
// The client pairs and checks in as active with a fake platform (commands run with `sh -c`, files are real, the screen
// is one fixed JPEG). Then this script does what a technician's AI does, over MCP on HTTP: device_connect, run,
// put_file and get_file of 1 MB, screenshot, the Mac's own refusals, a power action, install_program and
// uninstall_program (one .dmg install that reaches the fake platform, and the relay's Mac refusals) and session_end. Then the one-off
// link for a Mac: session_create, the redeem route's refusals, the core's redeem client joining with Auth::Attach, a
// command, the Windows button on a fresh code, and "Don't allow" on a second session. Any failed check
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
// The version the client reports: the core crate's (the Mac app's own version line).
const CORE_VERSION = /^version = "([^"]+)"/m.exec(readFileSync(join(agent, 'core/Cargo.toml'), 'utf8'))[1];
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
let joiners = [];
let prepared = null;
let protectedDir = null;
let bin = null;

async function main() {
  // 1. The client binary.
  const cargo = process.env.CARGO || 'cargo';
  const build = spawnSync(cargo, ['build', '--locked', '--bin', 'support-core-e2e'], { cwd: agent, stdio: 'inherit' });
  if (build.status !== 0) throw new Error('cargo build failed');
  bin = join(agent, 'target', 'debug', 'support-core-e2e');

  // 2. The relay.
  prepared = prepareConfig(root);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  wranglerRun(prepared, ['d1', 'migrations', 'apply', 'support-mcp', '--local']);
  // Rules the Mac must read: a Mac folder under a temp folder the run owns, and a Windows folder the Mac must never get.
  protectedDir = join(tmpdir(), `support-mac-e2e-protected-${process.pid}`);
  mkdirSync(protectedDir, { recursive: true });
  const doc = {
    time_zone: null, hours: null, restart: 'allow', shutdown: 'never', install: 'allow', uninstall: 'approve', close_program: 'allow',
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
  check('device_list shows the Mac as macOS, active, online and at the client version', !!mac && mac.os === 'macOS 26.1 (25B78)' && mac.status === 'active' && mac.online === true && mac.app_version === CORE_VERSION, JSON.stringify(mac));

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
  check('request_full_control is refused by the Mac', JSON.stringify(full).includes('a Mac cannot raise its control in a session'), JSON.stringify(full));

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

  // install_program and uninstall_program on a saved Mac (PR 6): the relay picks the Mac's checks by the hello's agent.
  const dmgPath = '/Users/Shared/Rectangle0.84.dmg';
  const dmg = await call('install_program', { session_id: sid, path: dmgPath });
  check('install_program with a .dmg path passes the relay\'s and the Mac\'s checks and reaches the fake platform', !dmg.isError && dmg.data.exit_code === 0 && String(dmg.data.detail).includes(dmgPath), JSON.stringify(dmg));
  await until('the platform to report the install', () => event('program'), 10_000, 100);
  for (const [what, args, want] of [
    ['a package in /System', { path: '/System/x.pkg' }, 'macOS\'s own folders'],
    ['a relative path', { path: 'Downloads/x.pkg' }, 'path is required: the absolute path of the installer on the PC'],
    ['an app bundle, which is no installer', { path: '/Users/Shared/Foo.app' }, 'installs only a .pkg or .mpkg package'],
    ['installer arguments', { path: '/Users/Shared/x.pkg', args: '-target /' }, 'takes no arguments'],
  ]) {
    const r = await call('install_program', { session_id: sid, ...args });
    check(`the relay refuses a Mac install of ${what}`, r.isError && JSON.stringify(r).includes(want), JSON.stringify(r));
  }
  for (const id of ['bundle:io.github.sukardaddy.supportmcp', 'bundle:io.github.sukardaddy.supportmcp.join']) {
    const r = await call('uninstall_program', { session_id: sid, program_id: id });
    check(`the relay refuses to uninstall ${id}`, r.isError && JSON.stringify(r).includes('protected_program: the Support app is never uninstalled'), JSON.stringify(r));
  }
  const apple = await call('uninstall_program', { session_id: sid, program_id: 'bundle:com.apple.TextEdit' });
  check('the relay refuses to uninstall one of Apple\'s apps', apple.isError && JSON.stringify(apple).includes('protected_program: Apple'), JSON.stringify(apple));
  await sleep(500);
  const reached = events.filter((e) => e.event === 'program').map((e) => e.line);
  check('only the allowed install reached the Mac; every refusal was the relay\'s', JSON.stringify(reached) === JSON.stringify([`install ${dmgPath}`]), JSON.stringify(reached));

  // End.
  const ended = await call('session_end', { session_id: sid });
  check('session_end ends the session', !ended.isError, JSON.stringify(ended));
  const status = await call('session_status', { session_id: sid });
  check('and the relay says it ended', status.data.state === 'ended', JSON.stringify(status.data));
  await until('the client to see the end', () => event('session_ended') || exitCode !== null, 30_000);
  check('the client saw the session end', !!event('session_ended'));
  await until('the client to exit', () => exitCode !== null, 30_000);
  check('and exits cleanly', exitCode === 0, `exit ${exitCode}`);

  // 5. A one-off link for a Mac: the same session_create link, the redeem route and the core's join client.
  const create = async (args = {}) => {
    const made = await call('session_create', { label: 'e2e join', ...args });
    if (made.isError) throw new Error(`session_create failed: ${JSON.stringify(made)}`);
    const code = /\/j\/([a-z2-7]{16})/.exec(made.data.download_url ?? made.data.one_liner ?? '')?.[1];
    if (!code) throw new Error(`no code in ${JSON.stringify(made.data)}`);
    return { sid: made.data.session_id, code, url: made.data.download_url };
  };
  const redeemRaw = (code, { headers, body = '{}' } = {}) => fetch(`${base}/j/${code}/redeem`, {
    method: 'POST', headers: headers ?? { 'content-type': 'application/json', 'x-support-client': 'macos-app-1' }, body,
  });
  const joinClient = (code, ...extra) => {
    const events = [];
    const child = spawn(bin, ['--origin', base, '--join', code, ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
    createInterface({ input: child.stdout }).on('line', (line) => {
      try { events.push(JSON.parse(line)); } catch (_) { console.log(`join client: ${line}`); }
    });
    const joiner = { events, child, exit: null, saw: (name) => events.find((e) => e.event === name) };
    child.on('exit', (code2) => { joiner.exit = code2; });
    joiners.push(joiner);
    return joiner;
  };

  const one = await create();
  const page = await (await fetch(one.url)).text();
  check('the one-off page has an On a Mac section with the code and the join link', page.includes('On a Mac') && page.includes(`supportmcp://join?code=${one.code}`), page.slice(0, 200));
  // A web page cannot redeem, and nothing here uses the code up.
  for (const [name, status, opts] of [
    ['an Origin header', 403, { headers: { 'content-type': 'application/json', 'x-support-client': 'macos-app-1', origin: base } }],
    ['a form content type', 415, { headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-support-client': 'macos-app-1' } }],
    ['no client header', 403, { headers: { 'content-type': 'application/json' } }],
    ['a body that is not JSON', 400, { body: 'nope' }],
  ]) {
    const r = await redeemRaw(one.code, opts);
    check(`redeem refuses ${name}`, r.status === status, `${r.status} ${await r.text()}`);
  }
  const preview = await redeemRaw(one.code, { body: '{"preview":true}' });
  const previewBody = await preview.json();
  check('a preview shows the label and uses nothing up', preview.status === 200 && previewBody.label === 'e2e join' && previewBody.origin === base, JSON.stringify(previewBody));
  const poweshell = await create({ windows_mode: 'powershell' });
  const wrong = await redeemRaw(poweshell.code);
  check('a code made for powershell is refused as the wrong client', wrong.status === 409 && (await wrong.json()).reason === 'wrong-client');

  const joined = joinClient(one.code);
  await until('the join client to attach', () => joined.saw('connected') || joined.saw('error') || (joined.exit !== null && { exit: joined.exit }), 60_000);
  check('the core client previews, redeems with the code and connects', !!joined.saw('preview') && joined.saw('preview').label === 'e2e join' && joined.saw('redeemed')?.sid === one.sid && !!joined.saw('connected'), JSON.stringify(joined.events));
  check('the key never reaches the client\'s output', !JSON.stringify(joined.events).includes('"key"'));
  const again = await redeemRaw(one.code);
  check('a second redeem of the same code is not-pending', again.status === 409 && (await again.json()).reason === 'not-pending');
  const status1 = await until('the one-off session to attach', async () => {
    const st = await call('session_status', { session_id: one.sid });
    return st.data.state === 'attached' ? st.data : null;
  }, 30_000, 300);
  check('the relay sees a Mac link session with normal control and the lanes', status1.control === 'normal' && status1.client_agent === 'macos-app-1' && status1.windows_mode === 'app' && status1.caps.includes('lanes'), JSON.stringify(status1));
  const hi = await call('run', { session_id: one.sid, command: 'echo one-off' });
  check('run "echo one-off" returns its output', hi.data.stdout?.trim() === 'one-off' && hi.data.exit_code === 0, JSON.stringify(hi));
  const sys = await call('run', { session_id: one.sid, command: 'echo x', as: 'system' });
  check('as:"system" is refused on a one-off Mac session', sys.isError || JSON.stringify(sys).includes('needs full control'), JSON.stringify(sys));
  const full2 = await call('request_full_control', { session_id: one.sid });
  check('request_full_control answers that a link session cannot', JSON.stringify(full2).includes('a Mac cannot raise its control in a session'), JSON.stringify(full2));
  const shot2 = await call('screenshot', { session_id: one.sid });
  check('a screenshot works on the one-off session', !!shot2.image, JSON.stringify(shot2.data));
  const end1 = await call('session_end', { session_id: one.sid });
  check('session_end ends the one-off session', !end1.isError, JSON.stringify(end1));
  await until('the join client to exit', () => joined.exit !== null, 30_000);
  check('and the join client sees the end and exits cleanly', joined.exit === 0 && joined.saw('session_end')?.how === 'relay', JSON.stringify(joined.events));

  // "Don't allow" on a second session ends it as declined.
  const second = await create();
  const declined = joinClient(second.code, '--decline');
  await until('the decline to be sent', () => declined.saw('declined') || declined.saw('error') || declined.exit !== null, 30_000);
  check('the join client says Don\'t allow and the relay took it', declined.saw('declined')?.sent === true, JSON.stringify(declined.events));
  const st2 = await call('session_status', { session_id: second.sid });
  check('a Mac decline ends the session as declined', st2.data.state === 'ended' && st2.data.ended_reason === 'declined', JSON.stringify(st2.data));

  // The Windows button still works on a fresh code, and the code is then used up for the Mac route.
  const third = await create();
  const exe = await fetch(third.url, { method: 'POST', headers: { origin: base } });
  const exeBytes = Buffer.from(await exe.arrayBuffer());
  check('the Windows download button still returns the exe on a fresh code', exe.status === 200 && exe.headers.get('content-type') === 'application/octet-stream' && exeBytes.subarray(0, 2).toString() === 'MZ', `${exe.status}`);
  const afterExe = await redeemRaw(third.code);
  check('a code the button used up cannot be redeemed', afterExe.status === 409 && (await afterExe.json()).reason === 'not-pending');
}

async function cleanup() {
  if (client && client.exitCode === null) client.kill('SIGKILL');
  for (const j of joiners) if (j.child.exitCode === null) j.child.kill('SIGKILL');
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
