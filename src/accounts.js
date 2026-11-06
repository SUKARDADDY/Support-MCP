// Sign-in data in the shared D1 database: people, their linked Google and
// Microsoft identities, browser sign-ins, emailed links and authenticator
// secrets. Every query on those tables is in this file. Nothing here knows
// about HTTP; src/auth.js drives it.
//
// Secrets are never stored as given: a sign-in cookie and an email link token
// are kept as SHA-256 hashes, recovery codes as keyed hashes, and the
// authenticator secret encrypted (AES-GCM) under a key derived from AUTH_SECRET.
import { base32Decode, base32Encode, hmacHex, open, randomBytes, randomToken, seal, sha256Hex, timingSafeEqual } from './crypto.js';
import { matchStep } from './totp.js';

const HOUR_MS = 3600_000;

export const SESSION_TOUCH_MS = 5 * 60_000; // last_seen is written at most this often
// The idle limit is never shorter than two touch intervals. A shorter one would
// sign out someone who is using the site, because last_seen is written no more
// often than SESSION_TOUCH_MS.
export const MIN_IDLE_MS = 2 * SESSION_TOUCH_MS;
// Sign-in rows that ended (expired or revoked) this long ago are deleted.
export const SESSION_KEEP_MS = 30 * 86400_000;
export const EMAIL_LINK_TTL_MS = 10 * 60_000;
export const EMAIL_LINKS_PER_HOUR = 5;
// Every FACTOR_FAILURES_PER_LOCK wrong tries in a row lock the factor. The first
// lock lasts FACTOR_LOCK_MS, each later one twice as long, up to FACTOR_LOCK_MAX_MS.
// Only a right code starts the count again.
export const FACTOR_FAILURES_PER_LOCK = 5;
export const FACTOR_LOCK_MS = 15 * 60_000;
export const FACTOR_LOCK_MAX_MS = 24 * HOUR_MS;
export const RECOVERY_CODES = 10;


// Recovery codes are 10 characters of a-z and 2-7, shown as xxxxx-xxxxx.
const normalizeRecovery = (text) => String(text ?? '').toLowerCase().replace(/[\s-]/g, '');
const RECOVERY_RE = /^[a-z2-7]{10}$/;

export function accountStore(db, { secret }) {
  const q = (sql, ...params) => db.prepare(sql).bind(...params);

  // ---- people and linked identities -------------------------------------------
  const userById = (id) => q('SELECT id, email, created_at, disabled_at FROM users WHERE id = ?', id).first();
  const userByEmail = (email) => q('SELECT id, email, created_at, disabled_at FROM users WHERE email = ?', email).first();

  // The person for a verified Google or Microsoft identity. `invited(email)` says
  // whether this address may have an account. A known (provider, subject) is
  // always the person it was first linked to, whatever address the provider
  // reports now. A new one links to the person with the verified address, who
  // is created on the way if the address is invited. A link is never moved.
  async function userForIdentity({ provider, subject, email }, invited) {
    const link = await q('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?', provider, subject).first();
    if (link) {
      const user = await userById(link.user_id);
      if (!user || user.disabled_at) return { refusal: 'unknown' };
      return (await invited(user.email)) ? { user } : { refusal: 'not_invited' };
    }
    let user = await userByEmail(email);
    if (!user) {
      if (!(await invited(email))) return { refusal: 'not_invited' };
      await q('INSERT INTO users(id, email, created_at, disabled_at) VALUES (?, ?, ?, NULL) ON CONFLICT(email) DO NOTHING',
        crypto.randomUUID(), email, Date.now()).run();
      user = await userByEmail(email);
    }
    if (user.disabled_at) return { refusal: 'unknown' };
    if (!(await invited(user.email))) return { refusal: 'not_invited' };
    await q('INSERT INTO user_identities(provider, subject, user_id, email_at_link, linked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider, subject) DO NOTHING',
      provider, subject, user.id, email, Date.now()).run();
    // If another request linked this identity first, it belongs to that person.
    const now = await q('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?', provider, subject).first();
    if (!now || now.user_id !== user.id) return { refusal: 'unknown' };
    return { user };
  }

  // The person for an address that proved itself by an emailed link.
  async function userForEmail(email, invited) {
    let user = await userByEmail(email);
    if (!user) {
      if (!(await invited(email))) return { refusal: 'not_invited' };
      await q('INSERT INTO users(id, email, created_at, disabled_at) VALUES (?, ?, ?, NULL) ON CONFLICT(email) DO NOTHING',
        crypto.randomUUID(), email, Date.now()).run();
      user = await userByEmail(email);
    }
    if (user.disabled_at) return { refusal: 'unknown' };
    if (!(await invited(user.email))) return { refusal: 'not_invited' };
    return { user };
  }

  // ---- browser sign-ins ---------------------------------------------------------
  // The cookie holds a random token. Only its hash is stored.
  async function createSession(userId, { maxMs }) {
    const token = randomToken(32);
    const now = Date.now();
    // Old rows are of no use: delete the ones that ended long ago, as email links are.
    await q('DELETE FROM login_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
      now - SESSION_KEEP_MS, now - SESSION_KEEP_MS).run();
    await q('INSERT INTO login_sessions(id_hash, user_id, created_at, last_seen, expires_at, factor_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)',
      await sha256Hex(token), userId, now, now, now + maxMs).run();
    return token;
  }

  // The live sign-in for a cookie value, or null: not found, revoked, idle too
  // long, past its absolute limit, or its person disabled. Idle and absolute
  // limits come from the current settings, so tightening them applies to
  // sign-ins already open. The idle limit is raised to MIN_IDLE_MS if it is shorter.
  //
  // `factorAt` is when this sign-in passed its authenticator code, but it counts
  // only while the person still has an authenticator that is no newer than that
  // code. If the factor row is gone (an operator reset it) or was replaced after
  // the code, the sign-in has no second factor.
  async function sessionForToken(token, { idleMs, maxMs }) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const idHash = await sha256Hex(token);
    const row = await q(`SELECT s.id_hash, s.user_id, s.created_at, s.last_seen, s.expires_at, s.factor_at, s.revoked_at,
        u.email AS email, u.disabled_at AS disabled_at, f.created_at AS factor_created_at
      FROM login_sessions s JOIN users u ON u.id = s.user_id
      LEFT JOIN user_factors f ON f.user_id = s.user_id WHERE s.id_hash = ?`, idHash).first();
    if (!row || row.revoked_at || row.disabled_at) return null;
    const now = Date.now();
    const idle = Math.max(idleMs, MIN_IDLE_MS);
    if (row.expires_at <= now || row.created_at + maxMs <= now || row.last_seen + idle <= now) return null;
    if (now - row.last_seen >= SESSION_TOUCH_MS) {
      await q('UPDATE login_sessions SET last_seen = ? WHERE id_hash = ? AND revoked_at IS NULL', now, idHash).run();
    }
    const factorCounts = row.factor_at !== null && row.factor_created_at !== null && row.factor_created_at !== undefined && row.factor_at >= row.factor_created_at;
    return { idHash, userId: row.user_id, email: row.email, factorAt: factorCounts ? row.factor_at : null, createdAt: row.created_at };
  }

  const markFactor = (idHash) => q('UPDATE login_sessions SET factor_at = ? WHERE id_hash = ? AND revoked_at IS NULL', Date.now(), idHash).run();
  const revokeSession = (idHash) => q('UPDATE login_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL', Date.now(), idHash).run();
  const revokeToken = async (token) => revokeSession(await sha256Hex(String(token)));
  // Ends every sign-in of this person except the one named. Returns how many it ended.
  const revokeOthers = async (userId, keepIdHash) =>
    (await q('UPDATE login_sessions SET revoked_at = ? WHERE user_id = ? AND id_hash <> ? AND revoked_at IS NULL', Date.now(), userId, keepIdHash).run()).meta.changes;
  const revokeAll = (userId) => q('UPDATE login_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', Date.now(), userId).run();

  // ---- emailed links --------------------------------------------------------------
  // Makes a link for `email` unless it already has EMAIL_LINKS_PER_HOUR in the
  // last hour. The count and the insert are one statement, so two requests at
  // once can't both pass. Returns the token to put in the email, or null.
  async function createEmailLink(email, bindingValue) {
    const token = randomToken(32);
    const now = Date.now();
    await q('DELETE FROM email_links WHERE created_at < ?', now - 2 * HOUR_MS).run();
    const r = await q(`INSERT INTO email_links(hash, email, binding_hash, expires_at, used_at, created_at)
      SELECT ?, ?, ?, ?, NULL, ? WHERE (SELECT COUNT(*) FROM email_links WHERE email = ? AND created_at > ?) < ?`,
      await sha256Hex(token), email, await sha256Hex(bindingValue), now + EMAIL_LINK_TTL_MS, now, email, now - HOUR_MS, EMAIL_LINKS_PER_HOUR).run();
    return r.meta.changes === 1 ? token : null;
  }

  // Redeems a link once, from the browser that asked for it. Returns the
  // address, or null for any link that is unknown, used, expired, or asked for
  // in another browser. A wrong browser does not use the link up.
  async function redeemEmailLink(token, bindingValue) {
    if (typeof token !== 'string' || typeof bindingValue !== 'string' || !token || !bindingValue) return null;
    const hash = await sha256Hex(token);
    const row = await q('SELECT email, binding_hash, expires_at, used_at FROM email_links WHERE hash = ?', hash).first();
    if (!row || row.used_at !== null) return null;
    if (!timingSafeEqual(row.binding_hash, await sha256Hex(bindingValue))) return null;
    const now = Date.now();
    const r = await q('UPDATE email_links SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?', now, hash, now).run();
    return r.meta.changes === 1 ? row.email : null;
  }

  // Does this browser's binding value still have a link that can be used?
  async function hasOpenLink(bindingValue) {
    if (typeof bindingValue !== 'string' || !bindingValue) return false;
    const row = await q('SELECT 1 AS open FROM email_links WHERE binding_hash = ? AND used_at IS NULL AND expires_at > ? LIMIT 1',
      await sha256Hex(bindingValue), Date.now()).first();
    return Boolean(row);
  }

  // ---- the second factor -------------------------------------------------------------
  const getFactor = (userId) => q('SELECT user_id, secret_enc, last_step, failed, locked_until, recovery_hashes, created_at FROM user_factors WHERE user_id = ?', userId).first();

  const newRecoveryCodes = () => Array.from({ length: RECOVERY_CODES }, () => base32Encode(randomBytes(7)).slice(0, 10).toLowerCase());
  const showRecovery = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;

  // Stores a confirmed authenticator and fresh recovery codes (shown to the
  // person once, here returned in the clear). `secretBytes` is the raw TOTP
  // secret, `step` the step of the code that confirmed it. Without `replace` it
  // refuses when the person already has one. Returns the codes, or null.
  async function saveFactor(userId, secretBytes, step, { replace }) {
    const codes = newRecoveryCodes();
    const hashes = JSON.stringify(await Promise.all(codes.map((c) => hmacHex(secret, 'recovery-code', c))));
    const enc = await seal(secret, 'factor-secret', base32Encode(secretBytes), userId);
    const conflict = replace
      ? `ON CONFLICT(user_id) DO UPDATE SET secret_enc = excluded.secret_enc, last_step = excluded.last_step, failed = 0,
          locked_until = NULL, recovery_hashes = excluded.recovery_hashes, created_at = excluded.created_at`
      : 'ON CONFLICT(user_id) DO NOTHING';
    const r = await q(`INSERT INTO user_factors(user_id, secret_enc, last_step, failed, locked_until, recovery_hashes, created_at)
      VALUES (?, ?, ?, 0, NULL, ?, ?) ${conflict}`, userId, enc, step, hashes, Date.now()).run();
    return r.meta.changes === 1 ? codes.map(showRecovery) : null;
  }

  // Checks a six-digit code or a recovery code for this person. Each try is
  // counted before the code is looked at, so many tries at once can't each get
  // a free look. The count and the lock are one statement: the try that makes
  // the count a multiple of FACTOR_FAILURES_PER_LOCK also sets locked_until, so
  // a crash can't leave a count without its lock. Only locked_until blocks a
  // try, never the count. The nth lock lasts FACTOR_LOCK_MS * 2^(n-1), up to
  // FACTOR_LOCK_MAX_MS, and even a right code is refused until it ends. A right
  // code clears the count and the lock.
  // Returns { ok: true, via: 'code' | 'recovery' }, or
  // { ok: false, reason: 'none' | 'locked' | 'wrong', lockedUntil? }.
  async function verifyFactor(userId, code) {
    const f = await getFactor(userId);
    if (!f) return { ok: false, reason: 'none' };
    const now = Date.now();
    const reserved = await q(`UPDATE user_factors SET failed = failed + 1,
        locked_until = CASE WHEN (failed + 1) % ? = 0
          THEN ? + MIN(?, ? * (1 << MIN((failed + 1) / ? - 1, 20))) ELSE locked_until END
      WHERE user_id = ? AND (locked_until IS NULL OR locked_until <= ?)`,
      FACTOR_FAILURES_PER_LOCK, now, FACTOR_LOCK_MAX_MS, FACTOR_LOCK_MS, FACTOR_FAILURES_PER_LOCK, userId, now).run();
    if (reserved.meta.changes !== 1) {
      const again = await getFactor(userId);
      if (!again) return { ok: false, reason: 'none' };
      return { ok: false, reason: 'locked', lockedUntil: again.locked_until };
    }
    let ok = false;
    let via = 'code';
    const text = String(code ?? '').replace(/\s/g, '');
    if (/^\d{6}$/.test(text)) {
      const plain = await open(secret, 'factor-secret', f.secret_enc, userId);
      if (plain) {
        const step = await matchStep(base32Decode(plain), text, now, f.last_step);
        if (step !== null) {
          const r = await q('UPDATE user_factors SET failed = 0, locked_until = NULL, last_step = ? WHERE user_id = ? AND last_step < ?', step, userId, step).run();
          ok = r.meta.changes === 1;
        }
      }
    } else {
      const norm = normalizeRecovery(code);
      if (RECOVERY_RE.test(norm)) {
        const want = await hmacHex(secret, 'recovery-code', norm);
        const list = JSON.parse(f.recovery_hashes);
        const index = list.findIndex((h) => timingSafeEqual(h, want));
        if (index >= 0) {
          const rest = list.filter((_, i) => i !== index);
          // Swap only if the list is still the one we read, so a code works once.
          const r = await q('UPDATE user_factors SET failed = 0, locked_until = NULL, recovery_hashes = ? WHERE user_id = ? AND recovery_hashes = ?',
            JSON.stringify(rest), userId, f.recovery_hashes).run();
          ok = r.meta.changes === 1;
          via = 'recovery';
        }
      }
    }
    if (ok) return { ok: true, via };
    const after = await getFactor(userId);
    return after && after.locked_until && after.locked_until > now
      ? { ok: false, reason: 'locked', lockedUntil: after.locked_until }
      : { ok: false, reason: 'wrong' };
  }

  async function recoveryLeft(userId) {
    const f = await getFactor(userId);
    return f ? JSON.parse(f.recovery_hashes).length : 0;
  }

  return {
    userById, userByEmail, userForIdentity, userForEmail,
    createSession, sessionForToken, markFactor, revokeSession, revokeToken, revokeOthers, revokeAll,
    createEmailLink, redeemEmailLink, hasOpenLink,
    getFactor, saveFactor, verifyFactor, recoveryLeft,
  };
}
