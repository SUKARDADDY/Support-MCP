// Walks the relay's sign-in pages in a browser, the way a person would: email link (shown on
// the page under DEV_SHOW_EMAIL_LINKS), the authenticator set-up with a code worked out here
// from the key the page shows, and the consent page. It ends when the browser is sent back
// to the app's loopback address (/callback). Page text is src/pages.js.
import { base32Decode } from '../../src/crypto.js';
import { totp } from '../../src/totp.js';

const isCallback = (url) => url.pathname === '/callback' && url.port !== '8787';

export async function walkSignIn(page, authorizeUrl, { email, say = () => {} }) {
  let secret = null;
  await page.goto(authorizeUrl).catch(() => {}); // the last redirect may land on the app's own address
  for (let step = 0; step < 16; step++) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const url = new URL(page.url());
    if (isCallback(url)) {
      say(`back at the app: ${url.origin}${url.pathname}`);
      return { callback: url, secret };
    }
    const heading = ((await page.locator('h1').first().textContent({ timeout: 10_000 })) ?? '').trim();
    say(`page: ${heading}`);
    if (heading === 'Sign in') {
      await page.fill('#email', email);
      await Promise.all([page.waitForLoadState('domcontentloaded'), page.getByRole('button', { name: 'Email me a sign-in link' }).click()]);
    } else if (heading === 'Check your email') {
      await Promise.all([page.waitForLoadState('domcontentloaded'), page.getByRole('link', { name: 'Open the sign-in link' }).click()]);
    } else if (heading === 'Finish signing in') {
      await Promise.all([page.waitForLoadState('domcontentloaded'), page.getByRole('button', { name: 'Sign in' }).click()]);
    } else if (heading === 'Set up your authenticator') {
      const text = (await page.locator('p.secret code').textContent()) ?? '';
      secret = base32Decode(text.replace(/\s/g, ''));
      await page.fill('#code', await totp(secret, Date.now()));
      await Promise.all([page.waitForLoadState('domcontentloaded'), page.getByRole('button', { name: 'Confirm' }).click()]);
    } else if (heading === 'Save your recovery codes') {
      await Promise.all([page.waitForLoadState('domcontentloaded'), page.getByRole('link', { name: 'I have saved them' }).click()]);
    } else if (heading === 'Enter your code') {
      if (!secret) throw new Error('the relay asked for a code before an authenticator was set up here');
      // A code is accepted once: the one just used for set-up is spent, so use the next 30-second step's (inside the relay's drift window).
      await page.fill('#code', await totp(secret, Date.now() + 30_000));
      await Promise.all([page.waitForLoadState('domcontentloaded'), page.getByRole('button', { name: 'Continue' }).click()]);
    } else if (heading.startsWith('Allow')) {
      const body = (await page.locator('body').textContent()) ?? '';
      if (!body.includes("Support technician app: works as you in")) throw new Error('the consent page did not carry the technician app text');
      await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), page.getByRole('button', { name: 'Allow' }).click().catch(() => {})]);
    } else {
      throw new Error(`an unexpected sign-in page: "${heading}" at ${page.url()}`);
    }
  }
  throw new Error(`sign-in did not finish; last page ${page.url()}`);
}
