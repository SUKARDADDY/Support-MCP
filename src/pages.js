// The sign-in and account pages: plain server-rendered HTML, no script, no
// external font or image. Colours are the Porcelain theme, light and dark by
// the browser's own setting. All visible text is in this file, in English.

import { safeNext } from './paths.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `*{box-sizing:border-box}
:root{color-scheme:light dark;--desk:#DCE1EA;--card:#FFFFFF;--ink:#111827;--ink-2:#4B5565;--rule:#D8DDE6;--rule-2:#E8EBF1;--live:#2F5BFF;--live-hover:#4A70FF;--on-live:#FFFFFF;--live-ink:#2346D6;--live-soft:#E8EDFF;--live-line:#B9C7FF;--online:#0E8457;--online-soft:#DCF2E8;--danger:#C22F3A;--danger-soft:#FBE4E6;--btn-border:#BAC2CF;--field-border:#AAB3C2;--focus:#2346D6;--muted-bg:#EEF1F5}
@media (prefers-color-scheme:dark){:root{--desk:#070A10;--card:#151B26;--ink:#E6EAF2;--ink-2:#9AA4B5;--rule:#263046;--rule-2:#1D2534;--live:#6B8DFF;--live-hover:#86A2FF;--on-live:#07102E;--live-ink:#9DB3FF;--live-soft:#18224A;--live-line:#2E4080;--online:#3DD598;--online-soft:#0F2D22;--danger:#FF8A92;--danger-soft:#3A1A1F;--btn-border:#34405A;--field-border:#3A4762;--focus:#9DB3FF;--muted-bg:#182030}}
html{background:var(--desk)}
body{margin:0;min-height:100vh;padding:24px 14px;background:var(--desk);color:var(--ink);font:16px/1.5 "Atkinson Hyperlegible Next",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.wrap{max-width:460px;margin:0 auto}
.brand{margin:0 0 14px 2px;color:var(--ink-2);font-size:15px;font-weight:600}
main{background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:22px 20px;box-shadow:0 1px 2px rgba(17,24,39,.06)}
h1{margin:0 0 8px;font-size:24px;line-height:1.25;font-weight:700}
h2{margin:26px 0 8px;font-size:17px;line-height:1.3;font-weight:700}
p{margin:0 0 12px}
.muted{color:var(--ink-2)}
.small{font-size:14px}
form{margin:0}
label{display:block;margin:14px 0 6px;font-weight:600}
input[type=text],input[type=email]{display:block;width:100%;min-height:48px;padding:0 12px;border:1px solid var(--field-border);border-radius:8px;background:var(--card);color:var(--ink);font:inherit}
input.code{letter-spacing:.12em;font-size:20px}
.btn{display:block;width:100%;min-height:48px;margin:12px 0 0;padding:0 16px;border:1px solid var(--btn-border);border-radius:8px;background:var(--card);color:var(--ink);font:inherit;font-weight:600;text-align:center;text-decoration:none;line-height:46px;cursor:pointer}
.btn:hover{background:var(--muted-bg)}
.btn.primary{border-color:var(--live);background:var(--live);color:var(--on-live)}
.btn.primary:hover{background:var(--live-hover)}
.btn.danger{border-color:var(--danger);color:var(--danger)}
a.btn{display:block}
button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
a{color:var(--live-ink)}
.or{margin:18px 0 2px;color:var(--ink-2);font-size:14px}
.note{margin:0 0 14px;padding:10px 12px;border:1px solid var(--live-line);border-radius:8px;background:var(--live-soft);color:var(--ink)}
.note.warn{border-color:var(--danger);background:var(--danger-soft)}
.note.ok{border-color:var(--online);background:var(--online-soft)}
dl{margin:0}
dt{margin:12px 0 2px;color:var(--ink-2);font-size:14px}
dd{margin:0;overflow-wrap:anywhere}
ul.plain{margin:0;padding:0;list-style:none}
ul.plain li{padding:10px 0;border-top:1px solid var(--rule-2)}
ul.plain li:first-child{border-top:0}
.role{color:var(--ink-2);font-size:14px}
code,pre{font:15px/1.5 "Atkinson Hyperlegible Mono",ui-monospace,"Cascadia Mono",Consolas,monospace}
.secret{margin:6px 0 12px;padding:12px;border:1px solid var(--rule);border-radius:8px;background:var(--muted-bg);overflow-wrap:anywhere}
.codes{margin:6px 0 12px;padding:12px;border:1px solid var(--rule);border-radius:8px;background:var(--muted-bg);columns:2;column-gap:20px}
.codes code{display:block}
@media (min-width:600px){body{padding-top:48px}main{padding:28px 28px}}`;

// The security headers on every page. `formTargets` lists the extra hosts a
// form on this page may send the browser to (the sign-in buttons).
export function pageHeaders(formTargets = []) {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTargets.length ? ` ${formTargets.join(' ')}` : ''}; frame-ancestors 'none'; base-uri 'none'`,
    // Not no-referrer: under it Chrome sends `Origin: null` on a form post, and
    // the Origin check would refuse every real button press.
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
}

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="wrap"><p class="brand">Support-MCP</p><main>${body}</main></div></body></html>`;
}

const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
const note = (text, kind = '') => `<p class="note${kind ? ` ${kind}` : ''}" role="${kind === 'warn' ? 'alert' : 'status'}">${esc(text)}</p>`;

// `outHref` is a plain link that leaves this site (the caller has checked it).
export function messagePage({ title, text, link, linkLabel, kind = '', outHref, outLabel }) {
  const out = outHref ? `<p class="small"><a href="${esc(outHref)}" rel="noreferrer">${esc(outLabel || 'Go back')}</a></p>` : '';
  return shell(title, `<h1>${esc(title)}</h1>${kind ? note(text, kind) : `<p>${esc(text)}</p>`}${link ? `<a class="btn primary" href="${esc(safeNext(link, 4000))}">${esc(linkLabel || 'Continue')}</a>` : ''}${out}`);
}

// ---- sign-in --------------------------------------------------------------------
export function signInPage({ providers, emailEnabled, next, csrf, message }) {
  const buttons = providers.map((p) => `<form method="get" action="/auth/${esc(p.name)}">${hidden('next', safeNext(next))}<button class="btn" type="submit">Continue with ${esc(p.label)}</button></form>`).join('');
  const email = emailEnabled
    ? `${providers.length ? '<p class="or">Or use your email address</p>' : ''}<form method="post" action="/auth/email">${hidden('csrf', csrf)}${hidden('next', safeNext(next))}<label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" inputmode="email" maxlength="200" required><button class="btn primary" type="submit">Email me a sign-in link</button></form>`
    : '';
  const none = !providers.length && !emailEnabled ? note('No sign-in method is set up on this server yet.', 'warn') : '';
  return shell('Sign in', `<h1>Sign in</h1><p class="muted">Sign in to see your workspaces and set up your second factor. Only people a team has added can sign in.</p>${message ? note(message) : ''}${none}${buttons}${email}`);
}

export function notInvitedPage() {
  return messagePage({
    title: 'You can’t sign in here',
    text: 'This address has not been added to a team on this server. Ask a team admin to add it, then try again.',
    link: '/auth/signin', linkLabel: 'Back to sign in',
  });
}

export function emailSentPage({ devLink }) {
  const dev = devLink
    ? `${note('Local development: the link is shown here instead of being emailed.', 'warn')}<p class="small"><a href="${esc(devLink)}">Open the sign-in link</a></p>`
    : '';
  return shell('Check your email', `<h1>Check your email</h1><p>If that address has been added to a team, we sent it a sign-in link. The link works once and expires in 10 minutes.</p><p class="muted">Open the link in this same browser.</p>${dev}<a class="btn" href="/auth/signin">Back to sign in</a>`);
}

export function emailConfirmPage({ token, csrf, ready, next }) {
  if (!ready) {
    return shell('Open this link in the same browser', `<h1>Open this link in the same browser</h1><p>Sign-in links work only in the browser that asked for them. Go back to that browser, or ask for a new link.</p><a class="btn" href="/auth/signin">Ask for a new link</a>`);
  }
  return shell('Finish signing in', `<h1>Finish signing in</h1><p>Press the button to sign in on this browser.</p><form method="post" action="/auth/email/confirm">${hidden('csrf', csrf)}${hidden('t', token)}${hidden('next', safeNext(next))}<button class="btn primary" type="submit">Sign in</button></form>`);
}

// ---- second factor ------------------------------------------------------------------
const groups = (text) => text.replace(/(.{4})/g, '$1 ').trim();

export function enrolPage({ secretText, uri, sealed, csrf, next, reset, message }) {
  return shell('Set up your authenticator', `<h1>Set up your authenticator</h1>
<p>${reset ? 'This replaces your current authenticator and your recovery codes.' : 'An authenticator app makes a new six-digit code every 30 seconds.'}</p>
${message ? note(message, 'warn') : ''}
<h2>1. Add the key to your app</h2>
<p class="small muted">On a phone, <a href="${esc(uri)}">open this link in your authenticator app</a>. Otherwise choose “enter a setup key” in the app and type this key. The account type is time-based.</p>
<p class="secret"><code>${esc(groups(secretText))}</code></p>
<h2>2. Enter the code it shows</h2>
<form method="post" action="/auth/factor">${hidden('csrf', csrf)}${hidden('action', 'enrol')}${hidden('sealed', sealed)}${hidden('next', safeNext(next))}<label for="code">Six-digit code</label><input id="code" class="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required><button class="btn primary" type="submit">Confirm</button></form>`);
}

export function recoveryCodesPage({ codes, next, endedOthers = false }) {
  return shell('Save your recovery codes', `<h1>Save your recovery codes</h1>
${note(endedOthers ? 'Your authenticator is set up. We signed you out of every other browser.' : 'Your authenticator is set up.', 'ok')}
<p>If you lose your phone, each of these codes signs you in once instead of an authenticator code. We can’t show them again, so store them somewhere safe now.</p>
<div class="codes">${codes.map((c) => `<code>${esc(c)}</code>`).join('')}</div>
<a class="btn primary" href="${esc(safeNext(next))}">I have saved them</a>`);
}

export function verifyPage({ csrf, next, message }) {
  return shell('Enter your code', `<h1>Enter your code</h1><p>Enter the six-digit code from your authenticator app, or one of your recovery codes.</p>${message ? note(message, 'warn') : ''}
<form method="post" action="/auth/factor">${hidden('csrf', csrf)}${hidden('action', 'verify')}${hidden('next', safeNext(next))}<label for="code">Code</label><input id="code" class="code" name="code" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" maxlength="14" required><button class="btn primary" type="submit">Continue</button></form>
<form method="post" action="/auth/signout">${hidden('csrf', csrf)}<button class="btn" type="submit">Sign out</button></form>`);
}

// ---- account --------------------------------------------------------------------------
export function accountPage({ email, workspaces, deploymentAdmin, factor, factorRequired, factorVerified, recoveryLeft, csrf }) {
  const ws = workspaces.length
    ? `<ul class="plain">${workspaces.map((w) => `<li>${esc(w.name)}<br><span class="role">${esc(w.slug)} · ${esc(w.role_name || w.role_id)}</span></li>`).join('')}</ul>`
    : '<p class="muted">You are not in a workspace yet.</p>';
  let factorBlock;
  if (factor) {
    factorBlock = `<p>${factorVerified ? 'Your authenticator is set up and was used for this sign-in.' : 'Your authenticator is set up.'} ${recoveryLeft} recovery ${recoveryLeft === 1 ? 'code is' : 'codes are'} left.</p>
<form method="get" action="/auth/factor">${hidden('reset', '1')}<button class="btn" type="submit">Replace my authenticator</button></form>`;
  } else {
    factorBlock = `${factorRequired ? note('Your role can control sessions or manage the team, so you need an authenticator before you can do that.', 'warn') : '<p class="muted">Optional for your role.</p>'}
<form method="get" action="/auth/factor"><button class="btn${factorRequired ? ' primary' : ''}" type="submit">Set up your authenticator</button></form>`;
  }
  return shell('Your account', `<h1>Your account</h1>
<dl><dt>Signed in as</dt><dd>${esc(email)}</dd>${deploymentAdmin ? '<dt>Deployment</dt><dd>Deployment admin</dd>' : ''}</dl>
<h2>Your workspaces</h2>${ws}
<h2>Second factor</h2>${factorBlock}
<h2>Sign out</h2>
<form method="post" action="/auth/signout">${hidden('csrf', csrf)}<button class="btn" type="submit">Sign out</button></form>
<form method="post" action="/account/signout-everywhere">${hidden('csrf', csrf)}<button class="btn danger" type="submit">Sign out everywhere</button></form>`);
}

// ---- OAuth consent --------------------------------------------------------------------
// Everything about the app comes from its registration or metadata document, so
// every value is escaped. The page names the app, where it sends the person
// back to, the workspace and what the person's role lets it do. The two buttons
// are separate forms so neither can fire from the other's fields.
export function consentPage({ email, clientName, clientDomain, redirectHost, redirectIsLoopback, redirectIsApp, workspaceName, workspaceSlug, roleName, abilities, technicianApp = false, csrf, handle }) {
  // The client chose these, so a very long value is cut short, not allowed to fill the page.
  const clip = (v, n) => (String(v).length > n ? `${String(v).slice(0, n)}…` : String(v));
  clientName = clip(clientName, 80);
  if (clientDomain) clientDomain = clip(clientDomain, 100);
  redirectHost = clip(redirectHost, 100);
  const who = clientDomain
    ? `<p class="small muted">Published by <strong>${esc(clientDomain)}</strong>.</p>`
    : '<p class="small muted">This app registered itself, so its name is not verified.</p>';
  const local = redirectIsLoopback
    ? note('This sends access to an app on your computer. Continue only if you just started signing in from it.', 'warn')
    : redirectIsApp
      ? note('This opens an app on your device through a link of its own. Continue only if you just started signing in from that app.', 'warn')
      : '';
  // The technician app works as the person on its own routes, so its page says
  // so in full, and says what it cannot do.
  const can = technicianApp
    ? `<p>Support technician app: works as you in ${esc(workspaceName)}, including seeing PCs and their screens, pairing and approving PCs, changing how they can be reached, and starting agent tasks. It can't change members, roles or agent keys. Only approve this if you just started signing in from the app.</p>`
    : abilities.length
      ? `<ul class="plain">${abilities.map((a) => `<li>${esc(a[0].toUpperCase() + a.slice(1))}</li>`).join('')}</ul>`
      : '<p class="muted">Nothing. Your role here holds no session permissions.</p>';
  const form = (decision, label, cls) => `<form method="post" action="/oauth/authorize">${hidden('csrf', csrf)}${hidden('handle', handle)}${hidden('decision', decision)}<button class="btn${cls}" type="submit">${label}</button></form>`;
  return shell('Allow access', `<h1>Allow ${esc(clientName)} to connect?</h1>
${who}${local}
<p>It will act as <strong>${esc(email)}</strong> in this workspace for up to 30 days. Signing out everywhere, or an admin removing you, ends it at once.</p>
<dl><dt>Workspace</dt><dd>${esc(workspaceName)} <span class="role">(${esc(workspaceSlug)})</span></dd>
<dt>Your role</dt><dd>${esc(roleName)}</dd>
<dt>After you allow, it returns to</dt><dd>${esc(redirectHost)}</dd></dl>
<h2>What it can do</h2>${can}
${form('approve', 'Allow', ' primary')}${form('deny', 'Deny', '')}`);
}
