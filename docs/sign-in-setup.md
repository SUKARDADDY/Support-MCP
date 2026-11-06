# Set up sign-in

People sign in at `https://<your host>/auth/signin` with Google, Microsoft or an
emailed link. Each method is optional, and a method with no settings is hidden.
Sign-in is by invitation: only a person who is a member of a workspace, or is
listed in `DEPLOYMENT_ADMINS`, can sign in. How it is built and checked is in
[the security model](security-model.md).

## Settings every method needs

1. Set `PUBLIC_ORIGIN` in `wrangler.toml` to your public address with no path,
   such as `https://support.example.com`. The provider redirect addresses below
   are built from it. A request for any other host, and a deploy with it empty,
   answers 503 on the sign-in pages.
2. Make a secret of 32 or more random characters and store it. It seals the
   sign-in cookie and the authenticator secrets.
   ```sh
   openssl rand -base64 48 | npx wrangler secret put AUTH_SECRET
   ```
   Without it every `/auth` and `/account` page answers 503.
3. Apply the database migrations, which add the sign-in tables:
   ```sh
   npx wrangler d1 migrations apply support-mcp --remote
   ```
4. Add a Cloudflare rate-limiting rule on `/auth/` (for example 20 requests a
   minute per IP). The relay limits emailed links to five an address an hour
   and wrong authenticator codes to five, but it does not limit other requests.
5. Optional: `SIGNIN_IDLE_HOURS` (default 12) and `SIGNIN_MAX_DAYS` (default 14)
   set how long a browser sign-in lasts without use, and in total.

## Google

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or
   create a project, then open **APIs & Services**, **OAuth consent screen**.
   Choose **Internal** if everyone is in your Google Workspace, otherwise
   **External**. The only scopes needed are `openid` and `email`.
2. Open **Credentials**, **Create credentials**, **OAuth client ID**, and choose
   **Web application**.
3. Under **Authorized redirect URIs** add
   `https://support.example.com/auth/google/callback` (your `PUBLIC_ORIGIN`
   plus `/auth/google/callback`). Leave JavaScript origins empty.
4. Copy the client ID into `GOOGLE_CLIENT_ID` in `wrangler.toml`, and store the
   client secret:
   ```sh
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
5. Deploy. The sign-in page now shows **Continue with Google**.

Only a Google account whose email Google reports as verified can sign in.

## Microsoft

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), open
   **App registrations**, **New registration**. Under **Supported account
   types** choose **Accounts in any organizational directory** for work and
   school accounts, or a single-tenant registration if only your own
   organisation signs in. Do not choose the option that adds personal Microsoft
   accounts. Personal accounts (outlook.com, hotmail.com, live.com) do not carry
   `xms_edov`, so this version refuses every one of them. Personal Microsoft
   accounts are not supported. Never list the personal-account tenant in
   `MICROSOFT_TENANTS` to get around this: that would trust addresses Microsoft
   has not confirmed. Use work or school accounts, or sign in with Google or an
   emailed link instead.
2. Under **Redirect URI** choose **Web** and enter
   `https://support.example.com/auth/microsoft/callback`.
3. Open **Certificates & secrets**, make a **New client secret**, and store its
   value (not its ID):
   ```sh
   npx wrangler secret put MICROSOFT_CLIENT_SECRET
   ```
   Put the **Application (client) ID** in `MICROSOFT_CLIENT_ID` in
   `wrangler.toml`.
4. Open **Token configuration**, **Add optional claim**, choose **ID**, and add
   `email` and `xms_edov`. Accept the prompt to turn on the Microsoft Graph
   email permission. `xms_edov` tells the relay that the email's domain owner
   confirmed the address. Without it, a Microsoft sign-in is refused unless the
   person's tenant is listed in `MICROSOFT_TENANTS`.
5. Optional: set `MICROSOFT_TENANTS` to a comma-separated list of tenant IDs
   (the directory ID on the app's overview page). Only those tenants can sign
   in, and for a listed tenant the relay does not need `xms_edov`: you are
   trusting that tenant's administrators to set email addresses honestly. Leave
   it empty to allow any tenant that sends `xms_edov`.
6. Deploy. The sign-in page now shows **Continue with Microsoft**.

A person is recognised by their Microsoft object ID inside their tenant, so a
changed email address does not change who they are.

## Email links with Resend

Emailed links work once, within 10 minutes, and only in the browser that asked.
The relay sends them through a mail provider. Resend is built in.

1. Make a [Resend](https://resend.com) account and **verify your sending
   domain** (add the DNS records Resend shows). A sender on an unverified domain
   is refused.
2. Make an API key with **Sending access**, and store it:
   ```sh
   npx wrangler secret put RESEND_API_KEY
   ```
3. In `wrangler.toml` set:
   ```toml
   MAIL_PROVIDER = "resend"
   MAIL_FROM = "Support <login@support.example.com>"
   ```
   The address in `MAIL_FROM` must be on the verified domain.
4. Deploy. The sign-in page now shows an email form.

The relay mails only addresses that are invited, and shows the same page for
every address. With `MAIL_PROVIDER` empty the email option is hidden and its
addresses answer 404.

## Add another mail provider

A provider is one file and one line.

1. Write `src/mail/<name>.js` exporting a function `(env, fetchFn) => mailer`.
   It returns `null` when its settings are missing, or an object with one
   method, `send({ to, subject, text, html })`, which sends the message and
   throws if the provider refuses it. Use `fetchFn` when given, else the global
   `fetch`, so tests can run without a network. Read its secrets from `env`
   (set them with `wrangler secret put`). [`src/mail/resend.js`](../src/mail/resend.js)
   is a 20-line example.
2. Add one line to the `PROVIDERS` table in `src/mail/index.js`:
   ```js
   import { postmarkMailer } from './postmark.js';
   export const PROVIDERS = Object.freeze({ resend: resendMailer, postmark: postmarkMailer });
   ```
3. Set `MAIL_PROVIDER = "postmark"` and add a test in `test/auth.test.js` that
   passes a fake `fetchFn` to `mailerFromEnv` the way the Resend test does.

## Invite the first people

Signing in does not add anyone to a team. Add people as members first, with
the team API (see [Teams](../README.md#teams)), or list yourself in
`DEPLOYMENT_ADMINS`. A person's identity is their lowercased email address, and
that address must be one their Google or Microsoft account (or inbox) proves.

## The second factor

A person whose role holds `sessions.control`, `members.manage` or
`roles.manage`, and every deployment admin, must set up an authenticator app.
The account page (`/account`) shows a **Set up your authenticator** button. It
gives a key to type into any authenticator app, and a link that opens it on a
phone. After a code from the app is accepted, the page shows ten recovery codes
once. Each signs in once if the phone is lost. Everyone who has set one up
enters a code at every sign-in. Five wrong codes in a row lock the account for
15 minutes, and each further five lock it for twice as long as the lock before
(30 minutes, an hour, and so on, up to 24 hours). The count starts again only
after a right code. Replacing the authenticator, or signing in with a recovery
code, ends every other browser sign-in of that person, and the page says so.
**Sign out everywhere** needs a code from the current sign-in when the person
has an authenticator.

To reset a person who lost both their phone and their recovery codes, after you
have checked who they are:

```sh
npx wrangler d1 execute support-mcp --remote \
  --command "DELETE FROM user_factors WHERE user_id = (SELECT id FROM users WHERE email = 'person@example.com')"
```

To lock a person out of sign-in and end their open sign-ins at their next
request, set `disabled_at` on their `users` row:

```sh
npx wrangler d1 execute support-mcp --remote \
  --command "UPDATE users SET disabled_at = strftime('%s','now') * 1000 WHERE email = 'person@example.com'"
```

Removing a person from every team has the same effect on sign-in, and it is the
normal way. They can also end their own sign-ins with **Sign out everywhere**.
