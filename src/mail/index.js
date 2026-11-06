// Mail providers for sign-in links. MAIL_PROVIDER names one entry in PROVIDERS.
// To add a provider, write src/mail/<name>.js exporting a function
// (env, fetchFn) => ({ send({ to, subject, text, html }) }) | null, which
// returns null when its settings are missing, and add one line to PROVIDERS.
import { resendMailer } from './resend.js';

export const PROVIDERS = Object.freeze({
  resend: resendMailer,
});

// The mailer for this deployment, or null when none is configured (the email
// sign-in option is then hidden and its routes answer 404). `providers` and
// `fetchFn` are for tests.
export function mailerFromEnv(env, { providers = PROVIDERS, fetchFn } = {}) {
  const name = String(env.MAIL_PROVIDER || '').trim().toLowerCase();
  if (!name || !Object.hasOwn(providers, name)) return null;
  return providers[name](env, fetchFn);
}
