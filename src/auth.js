// Technician sign-in: the /auth/* and /account routes. A person signs in with
// Google, Microsoft or an emailed link, passes an authenticator code if their
// role needs one, and gets a browser sign-in (a cookie holding a random value,
// stored hashed). This sign-in is for the account page now. The team API and
// /mcp still admit only Access logins and service tokens, so nothing here can
// reach a session or claim the open default workspace.
//
// These routes are for browsers, so they check what /mcp and /api refuse
// outright: a POST must carry an Origin equal to our own (when the browser
// sends one) and a form token tied to the sign-in, on top of SameSite cookies.
import { teamFromEnv, TeamError } from './workspace.js';
import { accountStore } from './accounts.js';
import { MIN_SECRET_LENGTH, hmacHex, open, randomToken, seal, timingSafeEqual, base32Decode, base32Encode } from './crypto.js';
import { authorizationUrl, exchangeCode, identityFromIdToken, newRoundTrip, providerConfig } from './oidc.js';
import { jwksKeyResolver } from './jwt.js';
import { readTextCapped } from './body.js';
import { DEFAULT_NEXT, safeNext } from './paths.js';
import { newSecret, matchStep, otpauthUri } from './totp.js';
import { mailerFromEnv } from './mail/index.js';
import { needsSecondFactor } from './permissions.js';
import {
  accountPage, emailConfirmPage, emailSentPage, enrolPage, messagePage, notInvitedPage, pageHeaders,
  recoveryCodesPage, signInPage, verifyPage,
} from './pages.js';

const ROUND_TRIP_MS = 10 * 60_000;
const ENROL_MS = 15 * 60_000;
const BINDING_MS = 10 * 60_000;
const PRE_MS = 60 * 60_000;
const FORM_MAX = 4096;
const PROVIDER_HOSTS = ['https://accounts.google.com', 'https://login.microsoftonline.com'];

const isLoopback = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1';

// ---- settings ----------------------------------------------------------------
function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Our own address, from PUBLIC_ORIGIN. Without it only a loopback request is
// served, at the address it arrived on. A request for another host than
// PUBLIC_ORIGIN names is refused, because the cookies would not follow it.
function ownOrigin(env, url) {
  const configured = String(env.PUBLIC_ORIGIN || '').trim();
  const local = isLoopback(url.hostname);
  if (!configured) return local ? { origin: `${url.protocol}//${url.host}` } : { error: 'PUBLIC_ORIGIN is not set' };
  let u;
  try { u = new URL(configured); } catch (_) { return { error: 'PUBLIC_ORIGIN is not a valid address' }; }
  const plain = u.protocol === 'http:' && isLoopback(u.hostname);
  if ((u.protocol !== 'https:' && !plain) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    return { error: 'PUBLIC_ORIGIN must be an https address with no path' };
  }
  if (url.origin === u.origin) return { origin: u.origin };
  if (local) return { origin: `${url.protocol}//${url.host}` };
  return { error: 'this is not the address in PUBLIC_ORIGIN' };
}

// A return path after sign-in is a path on this site and nothing else (src/paths.js).
// Every redirect below goes through it again, and so does every link in a page.
export { safeNext };

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const wellFormed = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(v);

// ---- the second-factor rule -----------------------------------------------------
// Does this sign-in hold `permission` in `workspace`, with the second factor
// that permission needs? Used by the account page and by anything else that
// acts on a sign-in (PR 2c's OAuth consent and tokens). Membership is read live.
// A role holding sessions.control, members.manage or roles.manage needs the
// person to have passed an authenticator code in this sign-in (`session.factorAt`).
export async function authorizeSignIn(team, session, workspace, permission) {
  const a = await team.authorize(workspace, session.email, permission);
  if (!a.ok) return { ok: false, reason: a.reason === 'not_member' ? 'not_member' : 'permission', message: a.reason === 'not_member' ? 'you are not a member of this team' : `your role does not allow ${permission}` };
  if (needsSecondFactor(permission) && !session.factorAt) return { ok: false, reason: 'second_factor', message: 'a second factor is required' };
  return { ok: true, role_id: a.role_id, open: a.open };
}

// Must this person have an authenticator? A deployment admin, or a member of
// any workspace whose role holds one of those permissions.
export function factorRequired(memberships, deploymentAdmin) {
  return deploymentAdmin || memberships.some((m) => m.permissions.some(needsSecondFactor));
}

// ---- the router --------------------------------------------------------------------
// deps: { fetchFn, mailer, waitUntil } are for tests and the Worker runtime.
export async function handleAuth(request, env, url, deps = {}) {
  const secret = typeof env.AUTH_SECRET === 'string' ? env.AUTH_SECRET : '';
  const unavailable = (text) => new Response(messagePage({ title: 'Sign-in is not available', text }), { status: 503, headers: pageHeaders() });
  if (secret.length < MIN_SECRET_LENGTH) return unavailable(`Sign-in is not configured. The server operator must set AUTH_SECRET (at least ${MIN_SECRET_LENGTH} characters).`);
  const where = ownOrigin(env, url);
  if (where.error) return unavailable(`Sign-in is not configured. ${where.error[0].toUpperCase()}${where.error.slice(1)}.`);

  const secure = where.origin.startsWith('https:');
  const cookieName = (base) => (secure ? `__Host-${base}` : base);
  const names = { session: cookieName('smcp'), oidc: cookieName('smcp-oidc'), bind: cookieName('smcp-bind'), pre: cookieName('smcp-pre') };
  const mailer = deps.mailer !== undefined ? deps.mailer : mailerFromEnv(env, { fetchFn: deps.fetchFn });
  const devShow = env.DEV_SHOW_EMAIL_LINKS === '1' && isLoopback(url.hostname);
  const c = {
    request, env, url, secret, origin: where.origin, secure, names, mailer, devShow,
    cookies: parseCookies(request.headers.get('cookie')),
    fetchFn: deps.fetchFn || ((u, init) => fetch(u, init)),
    waitUntil: deps.waitUntil,
    idleMs: positive(env.SIGNIN_IDLE_HOURS, 12) * 3600_000,
    maxMs: positive(env.SIGNIN_MAX_DAYS, 14) * 86400_000,
    emailEnabled: Boolean(mailer) || devShow,
  };

  try {
    c.team = teamFromEnv(env);
    c.accounts = accountStore(env.DB, { secret });
    return await route(c);
  } catch (e) {
    // Nothing is logged: an error here may carry an address or a token.
    if (e instanceof TeamError && e.status === 503) return unavailable('Sign-in is not available right now.');
    return new Response(messagePage({ title: 'Something went wrong', text: 'Try again in a moment.' }), { status: 500, headers: pageHeaders() });
  }
}

// ---- responses ---------------------------------------------------------------------
function cookieHeader(c, base, value, maxAgeSeconds) {
  return `${c.names[base]}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${c.secure ? '; Secure' : ''}`;
}
const setCookie = (c, base, value, ms) => cookieHeader(c, base, value, Math.floor(ms / 1000));
const clearCookie = (c, base) => cookieHeader(c, base, '', 0);

function respond(body, status, cookies = [], formTargets = []) {
  const headers = new Headers(pageHeaders(formTargets));
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(body, { status, headers });
}

// A redirect inside this site. The path always passes safeNext on its way out,
// so no value, however it got here, can send a person to another host.
function redirect(path, cookies = [], status = 303) {
  return redirectTo(safeNext(path, 4000), cookies, status);
}

// The one redirect that leaves the site: to the sign-in provider.
function redirectTo(location, cookies = [], status = 303) {
  const headers = new Headers({ location, 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status, headers });
}

const page = (title, text, status = 400, extra = {}) => respond(messagePage({ title, text, ...extra }), status);
const methodNotAllowed = (allow) => new Response(messagePage({ title: 'Method not allowed', text: `Use ${allow} for this address.` }), { status: 405, headers: { ...pageHeaders(), allow } });
const notFound = () => respond(messagePage({ title: 'Not found', text: 'There is nothing at this address.', link: '/auth/signin', linkLabel: 'Sign in' }), 404);
const signInUrl = (next) => `/auth/signin?next=${encodeURIComponent(next)}`;

// ---- guards ---------------------------------------------------------------------------
// A form post must come from our own pages: an Origin, when the browser sends
// one, equal to ours; a urlencoded body of sensible size. Returns the fields,
// or a Response to send back.
async function readForm(c) {
  const origin = c.request.headers.get('origin');
  if (origin !== null && origin !== c.origin) return page('Request refused', 'This request did not come from this site.', 403);
  const type = (c.request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return page('Request refused', 'Send this form from the page.', 415);
  // Read with a cap: a body with no Content-Length is cut off at FORM_MAX bytes.
  const text = await readTextCapped(c.request, FORM_MAX);
  if (text === null) return page('Request refused', 'The form is too large.', 413);
  const fields = {};
  for (const [k, v] of new URLSearchParams(text)) if (!(k in fields)) fields[k] = v;
  return { fields };
}

const csrfFor = (c, kind, value) => hmacHex(c.secret, 'csrf', `${kind}:${value}`);
async function csrfOk(c, kind, value, given) {
  return typeof given === 'string' && value !== undefined && timingSafeEqual(await csrfFor(c, kind, value), given);
}
const staleForm = () => page('This page has expired', 'Go back, reload the page and try again.', 403, { link: '/auth/signin', linkLabel: 'Sign in' });

async function currentSession(c) {
  const token = c.cookies[c.names.session];
  if (!token) return null;
  const session = await c.accounts.sessionForToken(token, { idleMs: c.idleMs, maxMs: c.maxMs });
  // Everything is read live: a person removed from their last team, or from
  // DEPLOYMENT_ADMINS, is signed out on this request.
  if (!session || !(await c.team.isInvited(session.email))) return null;
  return session;
}

async function startSession(c, user, next) {
  // A new sign-in replaces any the browser still holds.
  const old = c.cookies[c.names.session];
  if (old) await c.accounts.revokeToken(old);
  const token = await c.accounts.createSession(user.id, { maxMs: c.maxMs });
  const factor = await c.accounts.getFactor(user.id);
  const cookie = setCookie(c, 'session', token, c.maxMs);
  return redirect(factor ? `/auth/factor?next=${encodeURIComponent(next)}` : next, [cookie]);
}

// ---- routes -----------------------------------------------------------------------------
async function route(c) {
  const p = c.url.pathname;
  const method = c.request.method;
  let m;
  if (p === '/auth/signin') return method === 'GET' ? signIn(c) : methodNotAllowed('GET');
  if ((m = /^\/auth\/(google|microsoft)$/.exec(p))) return method === 'GET' ? oidcStart(c, m[1]) : methodNotAllowed('GET');
  if ((m = /^\/auth\/(google|microsoft)\/callback$/.exec(p))) return method === 'GET' ? oidcCallback(c, m[1]) : methodNotAllowed('GET');
  if (p === '/auth/email') {
    if (!c.emailEnabled) return notFound();
    return method === 'POST' ? emailRequest(c) : methodNotAllowed('POST');
  }
  if (p === '/auth/email/confirm') {
    if (!c.emailEnabled) return notFound();
    if (method === 'GET') return emailConfirmGet(c);
    return method === 'POST' ? emailConfirmPost(c) : methodNotAllowed('GET, POST');
  }
  if (p === '/auth/factor') {
    if (method === 'GET') return factorGet(c);
    return method === 'POST' ? factorPost(c) : methodNotAllowed('GET, POST');
  }
  if (p === '/auth/signout') return method === 'POST' ? signOut(c, false) : methodNotAllowed('POST');
  if (p === '/account/signout-everywhere') return method === 'POST' ? signOut(c, true) : methodNotAllowed('POST');
  if (p === '/account') return method === 'GET' ? account(c) : methodNotAllowed('GET');
  return notFound();
}

// ---- sign-in page -------------------------------------------------------------------------
const NOTICES = { signed_out: 'You are signed out.', failed: 'That sign-in did not work. Try again.' };

async function signIn(c) {
  const next = safeNext(c.url.searchParams.get('next'));
  if (await currentSession(c)) return redirect(next);
  const providers = ['google', 'microsoft'].map((n) => providerConfig(n, c.env)).filter(Boolean).map((p) => ({ name: p.name, label: p.label }));
  let pre = c.cookies[c.names.pre];
  const cookies = [];
  if (!wellFormed(pre)) {
    pre = randomToken(16);
    cookies.push(setCookie(c, 'pre', pre, PRE_MS));
  }
  const message = NOTICES[c.url.searchParams.get('m')] || '';
  const html = signInPage({ providers, emailEnabled: c.emailEnabled, next, csrf: await csrfFor(c, 'pre', pre), message });
  return respond(html, 200, cookies, providers.length ? PROVIDER_HOSTS : []);
}

// ---- Google and Microsoft ----------------------------------------------------------------------
// The round trip's state, nonce and PKCE verifier live in one sealed cookie
// (AES-GCM under a key derived from AUTH_SECRET) for ten minutes, not in a table.
async function oidcStart(c, name) {
  const cfg = providerConfig(name, c.env);
  if (!cfg) return notFound();
  const next = safeNext(c.url.searchParams.get('next'));
  const trip = await newRoundTrip();
  const sealed = await seal(c.secret, 'cookie', JSON.stringify({ p: name, s: trip.state, n: trip.nonce, v: trip.verifier, r: next, e: Date.now() + ROUND_TRIP_MS }), name);
  const target = authorizationUrl(cfg, { redirectUri: `${c.origin}/auth/${name}/callback`, state: trip.state, nonce: trip.nonce, challenge: trip.challenge });
  return redirectTo(target, [setCookie(c, 'oidc', sealed, ROUND_TRIP_MS)], 302);
}

async function oidcCallback(c, name) {
  const cfg = providerConfig(name, c.env);
  if (!cfg) return notFound();
  const clear = clearCookie(c, 'oidc');
  const failed = (text = 'That sign-in did not work. Start again from the sign-in page.', status = 400) =>
    respond(messagePage({ title: 'Sign-in failed', text, link: '/auth/signin', linkLabel: 'Back to sign in' }), status, [clear]);

  const sealed = c.cookies[c.names.oidc];
  const plain = sealed ? await open(c.secret, 'cookie', sealed, name) : null;
  let trip = null;
  try { trip = plain ? JSON.parse(plain) : null; } catch (_) { /* tampered beyond use */ }
  if (!trip || trip.p !== name || typeof trip.e !== 'number' || trip.e <= Date.now()
    || typeof trip.s !== 'string' || typeof trip.n !== 'string' || typeof trip.v !== 'string') {
    return failed('That sign-in expired or was started in another browser. Start again from the sign-in page.');
  }
  const state = c.url.searchParams.get('state');
  const code = c.url.searchParams.get('code');
  if (c.url.searchParams.has('error') || !code || !timingSafeEqual(String(state ?? ''), trip.s)) return failed();

  let identity;
  try {
    const idToken = await exchangeCode(cfg, { code, redirectUri: `${c.origin}/auth/${name}/callback`, verifier: trip.v, fetchFn: c.fetchFn });
    identity = await identityFromIdToken(name, idToken, { env: c.env, nonce: trip.n, keyResolver: jwksKeyResolver(cfg.jwksUrl, c.fetchFn) });
  } catch (_) {
    return failed('We could not verify that sign-in. Start again, and use an account whose email address is verified.', 403);
  }
  const found = await c.accounts.userForIdentity(identity, (email) => c.team.isInvited(email));
  if (found.refusal) return respond(notInvitedPage(), 403, [clear]);
  const res = await startSession(c, found.user, safeNext(trip.r));
  res.headers.append('set-cookie', clear);
  return res;
}

// ---- email links -----------------------------------------------------------------------------------
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function emailRequest(c) {
  const form = await readForm(c);
  if (form instanceof Response) return form;
  const pre = c.cookies[c.names.pre];
  if (!wellFormed(pre) || !(await csrfOk(c, 'pre', pre, form.fields.csrf))) return staleForm();
  const email = String(form.fields.email ?? '').trim().toLowerCase();
  if (!email || email.length > 200 || !EMAIL_RE.test(email)) return page('Check the address', 'Enter a valid email address.', 400, { link: '/auth/signin', linkLabel: 'Back to sign in' });
  const next = safeNext(form.fields.next);

  // The answer is the same for every address. The binding cookie is always set.
  // A browser that already holds one keeps its value, so a second request does
  // not strand the link from the first. Each link still stores its own hash.
  const held = c.cookies[c.names.bind];
  const binding = wellFormed(held) ? held : randomToken(32);
  const work = async () => {
    if (!(await c.team.isInvited(email))) return null;
    const token = await c.accounts.createEmailLink(email, binding);
    if (!token) return null; // over the limit of five an hour
    const link = `${c.origin}/auth/email/confirm?t=${token}${next === DEFAULT_NEXT ? '' : `&next=${encodeURIComponent(next)}`}`;
    if (c.devShow) return link;
    await c.mailer.send({
      to: email,
      subject: 'Your sign-in link',
      text: `Open this link in the browser where you asked to sign in. It works once and expires in 10 minutes.\n\n${link}\n\nIf you did not ask for this, ignore this email.`,
      html: `<p>Open this link in the browser where you asked to sign in. It works once and expires in 10 minutes.</p><p><a href="${link.replace(/&/g, '&amp;')}">Sign in</a></p><p>If you did not ask for this, ignore this email.</p>`,
    });
    return null;
  };
  let devLink = null;
  if (c.devShow || !c.waitUntil) {
    try { devLink = await work(); } catch (_) { /* the answer is the same if sending failed */ }
  } else {
    // Send after answering, so the answer's timing doesn't show whether the address is invited.
    c.waitUntil(work().catch(() => {}));
  }
  return respond(emailSentPage({ devLink }), 200, [setCookie(c, 'bind', binding, BINDING_MS)]);
}

// Opening the link only shows a page. Mail scanners and link previews open
// links with GET, so only the button's POST can use it up.
async function emailConfirmGet(c) {
  const token = c.url.searchParams.get('t') || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return page('This link does not work', 'Ask for a new sign-in link.', 400, { link: '/auth/signin', linkLabel: 'Back to sign in' });
  const bind = c.cookies[c.names.bind];
  const ready = wellFormed(bind);
  const csrf = ready ? await csrfFor(c, 'bind', bind) : '';
  return respond(emailConfirmPage({ token, csrf, ready, next: safeNext(c.url.searchParams.get('next')) }), 200);
}

async function emailConfirmPost(c) {
  const form = await readForm(c);
  if (form instanceof Response) return form;
  const bind = c.cookies[c.names.bind];
  if (!wellFormed(bind) || !(await csrfOk(c, 'bind', bind, form.fields.csrf))) return staleForm();
  const bad = () => respond(messagePage({ title: 'This link does not work', text: 'It was already used, has expired, or was asked for in another browser. Ask for a new one.', link: '/auth/signin', linkLabel: 'Back to sign in' }), 400);
  const email = await c.accounts.redeemEmailLink(String(form.fields.t ?? ''), bind);
  if (!email) return bad();
  const found = await c.accounts.userForEmail(email, (e) => c.team.isInvited(e));
  // Keep the binding cookie while this browser has another link it can still use.
  const spent = (await c.accounts.hasOpenLink(bind)) ? [] : [clearCookie(c, 'bind')];
  if (found.refusal) return respond(notInvitedPage(), 403, spent);
  const res = await startSession(c, found.user, safeNext(form.fields.next));
  for (const cookie of spent) res.headers.append('set-cookie', cookie);
  return res;
}

// ---- the second factor -------------------------------------------------------------------------------
// The setup page for a new authenticator key. The key travels in the page as
// a sealed value tied to this sign-in, so nothing is stored until a code
// from the app proves it was added. Pass `secretBytes` and `sealed` to show the
// same key again after a wrong code.
async function enrolView(c, session, { reset, next, message, status = 200, secretBytes = newSecret(), sealed }) {
  sealed = sealed || await seal(c.secret, 'enrol', JSON.stringify({ s: base32Encode(secretBytes), e: Date.now() + ENROL_MS }), session.idHash);
  const uri = otpauthUri({ secretBytes, account: session.email, issuer: 'Support-MCP' });
  const csrf = await csrfFor(c, 'session', session.idHash);
  return respond(enrolPage({ secretText: base32Encode(secretBytes), uri, sealed, csrf, next, reset, message }), status);
}

async function factorGet(c) {
  const next = safeNext(c.url.searchParams.get('next'));
  const session = await currentSession(c);
  if (!session) return redirect(signInUrl(`/auth/factor?next=${encodeURIComponent(next)}`));
  const factor = await c.accounts.getFactor(session.userId);
  const csrf = await csrfFor(c, 'session', session.idHash);
  if (!factor) return enrolView(c, session, { reset: false, next });
  if (!session.factorAt) return respond(verifyPage({ csrf, next }), 200);
  if (c.url.searchParams.get('reset') === '1') return enrolView(c, session, { reset: true, next });
  return redirect(next);
}

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

async function factorPost(c) {
  const form = await readForm(c);
  if (form instanceof Response) return form;
  const session = await currentSession(c);
  if (!session) return redirect(signInUrl(DEFAULT_NEXT));
  if (!(await csrfOk(c, 'session', session.idHash, form.fields.csrf))) return staleForm();
  const next = safeNext(form.fields.next);
  const csrf = await csrfFor(c, 'session', session.idHash);

  if (form.fields.action === 'verify') {
    const r = await c.accounts.verifyFactor(session.userId, form.fields.code);
    if (r.ok) {
      await c.accounts.markFactor(session.idHash);
      if (r.via === 'recovery') {
        // A recovery code means the phone may be lost or stolen: end every other sign-in.
        await c.accounts.revokeOthers(session.userId, session.idHash);
        const left = await c.accounts.recoveryLeft(session.userId);
        return respond(messagePage({
          title: 'You are signed in',
          text: `You used a recovery code. We signed you out of every other browser. ${left} recovery ${left === 1 ? 'code is' : 'codes are'} left. If you lost your phone, replace your authenticator from your account page.`,
          kind: 'ok', link: next, linkLabel: 'Continue',
        }));
      }
      return redirect(next);
    }
    if (r.reason === 'locked') {
      return respond(verifyPage({ csrf, next, message: `Too many wrong codes. Try again in ${minutes(r.lockedUntil - Date.now())} minutes.` }), 429);
    }
    if (r.reason === 'none') return redirect(`/auth/factor?next=${encodeURIComponent(next)}`);
    return respond(verifyPage({ csrf, next, message: 'That code did not work. Try the next one your app shows.' }), 400);
  }

  if (form.fields.action === 'enrol') {
    const existing = await c.accounts.getFactor(session.userId);
    // Replacing an authenticator needs a code from the current one first.
    if (existing && !session.factorAt) return redirect(`/auth/factor?next=${encodeURIComponent(next)}`);
    const plain = await open(c.secret, 'enrol', String(form.fields.sealed ?? ''), session.idHash);
    let pending = null;
    try { pending = plain ? JSON.parse(plain) : null; } catch (_) { /* unusable */ }
    if (!pending || typeof pending.s !== 'string' || typeof pending.e !== 'number' || pending.e <= Date.now()) {
      return enrolView(c, session, { reset: Boolean(existing), next, message: 'That setup page expired. Add the new key and try again.', status: 400 });
    }
    const secretBytes = base32Decode(pending.s);
    const step = await matchStep(secretBytes, form.fields.code, Date.now(), 0);
    if (step === null) {
      return enrolView(c, session, { reset: Boolean(existing), next, message: 'That code did not match. Check the key in your app and try the next code.', status: 400, secretBytes, sealed: String(form.fields.sealed) });
    }
    const codes = await c.accounts.saveFactor(session.userId, secretBytes, step, { replace: Boolean(existing) });
    if (!codes) return redirect(`/auth/factor?next=${encodeURIComponent(next)}`);
    await c.accounts.markFactor(session.idHash);
    // A new authenticator is a new start: every other sign-in must earn its place again.
    const ended = await c.accounts.revokeOthers(session.userId, session.idHash);
    return respond(recoveryCodesPage({ codes, next, endedOthers: ended > 0 }), 200);
  }
  return page('Request refused', 'Unknown action.', 400);
}

// ---- account and sign-out ---------------------------------------------------------------------------------
async function account(c) {
  const session = await currentSession(c);
  if (!session) return redirect(signInUrl(DEFAULT_NEXT));
  const factor = await c.accounts.getFactor(session.userId);
  if (factor && !session.factorAt) return redirect(`/auth/factor?next=${encodeURIComponent(DEFAULT_NEXT)}`);
  const workspaces = await c.team.memberships(session.email);
  const deploymentAdmin = c.team.isDeploymentAdmin(session.email);
  return respond(accountPage({
    email: session.email, workspaces, deploymentAdmin,
    factor: Boolean(factor), factorVerified: Boolean(session.factorAt),
    factorRequired: factorRequired(workspaces, deploymentAdmin),
    recoveryLeft: factor ? await c.accounts.recoveryLeft(session.userId) : 0,
    csrf: await csrfFor(c, 'session', session.idHash),
  }), 200);
}

async function signOut(c, everywhere) {
  const form = await readForm(c);
  if (form instanceof Response) return form;
  const token = c.cookies[c.names.session];
  // Read the sign-in without the invite check: a person who was removed can
  // still end their own sign-in.
  const session = token ? await c.accounts.sessionForToken(token, { idleMs: c.idleMs, maxMs: c.maxMs }) : null;
  if (session) {
    if (!(await csrfOk(c, 'session', session.idHash, form.fields.csrf))) return staleForm();
    if (everywhere) {
      // Ending every sign-in is a sensitive act: with an authenticator, this
      // sign-in must have passed a code first.
      if (!session.factorAt && (await c.accounts.getFactor(session.userId))) return redirect(`/auth/factor?next=${encodeURIComponent(DEFAULT_NEXT)}`);
      await c.accounts.revokeAll(session.userId);
    }
    else await c.accounts.revokeSession(session.idHash);
  }
  return redirect('/auth/signin?m=signed_out', [clearCookie(c, 'session')]);
}
