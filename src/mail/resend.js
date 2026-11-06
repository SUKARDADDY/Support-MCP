// Resend (https://resend.com): one POST to its emails endpoint. The API key is
// the RESEND_API_KEY Wrangler secret; MAIL_FROM is the verified sender address.
export const RESEND_URL = 'https://api.resend.com/emails';

export function resendMailer(env, fetchFn) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return null;
  const doFetch = fetchFn || ((u, init) => fetch(u, init));
  return {
    async send({ to, subject, text, html }) {
      const r = await doFetch(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, html }),
      });
      if (!r.ok) throw new Error(`mail provider answered ${r.status}`);
    },
  };
}
