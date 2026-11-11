# Connect MCP clients with OAuth

An MCP client such as Claude Code, Codex, Cursor or VS Code can sign in to the
relay as a person. The person signs in once in a browser, approves the client on
a consent page, and from then on the client's token acts as them, in one
workspace. The tools, roles and audit log work as they do for any other caller:
the log shows the person's email.

OAuth is optional. Access logins and service tokens keep working on every MCP
address. How it is built and checked is in [the security model](security-model.md).

## Set it up

1. Finish [sign-in setup](sign-in-setup.md): `PUBLIC_ORIGIN`, `AUTH_SECRET`, the
   migrations, and at least one sign-in method. The consent page needs a browser
   sign-in.
2. Create the KV namespace the OAuth server stores its data in, and put the id
   it prints in `wrangler.toml` as the `OAUTH_KV` binding:
   ```sh
   npx wrangler kv namespace create OAUTH_KV
   ```
   The binding must be named `OAUTH_KV`. Without it OAuth is off: the OAuth
   addresses answer 404 and the MCP addresses ignore a bearer token.
3. Keep the `global_fetch_strictly_public` compatibility flag that
   `wrangler.toml` sets. It lets the relay read a client's metadata document
   safely (see [Client registration](#client-registration)).
4. Let the relay answer its own OAuth addresses. If you use Cloudflare Access,
   run the setup script again with `OAUTH=1`:
   ```sh
   OAUTH=1 CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
   SUPPORT_HOST=support.example.com SUPPORT_OPERATOR_EMAIL=you@example.com \
   cf/access-setup.sh
   ```
   The script keeps the Access app `support-mcp` on `/api` only (you and the
   service token, as before) and adds a second app, `support-mcp-mcp`, on `/mcp`
   and `/w/*`. The second app has two policies, in this order: Service Auth for
   the same service token, then Bypass for everyone. Cloudflare evaluates Bypass
   and Service Auth policies first, top to bottom. A request that carries the
   service token gets an Access login, and every other request (an OAuth bearer
   token, discovery, no credential) goes straight to the relay. `/oauth/`,
   `/.well-known/`, `/auth/` and `/account` stay outside Access.
5. Put the second app's AUD, which the script prints, in `wrangler.toml` as
   `ACCESS_MCP_AUD`. On the MCP addresses only, the relay then accepts an Access
   login for either app. The team API accepts the first app's AUD only. With
   `ACCESS_MCP_AUD` empty nothing changes.
6. Deploy. Check `https://support.example.com/.well-known/oauth-authorization-server`
   returns a document.

Do not turn on Access **Managed OAuth** for the same addresses. Access would
answer the discovery requests with its own authorization server, and a client
would sign in there instead of here. It would not know your teams or roles.

Service tokens keep working on the MCP addresses in both modes. Without `OAUTH`,
Access guards `/mcp` and `/w/*`. With `OAUTH=1`, the second Access app gives a
service-token request an Access login and passes everything else through.

The bypass has a cost. Access session revocation does not apply on a bypassed
path, so ending an Access session in the dashboard does not stop a request there.
The relay's own checks are the gate on those paths: the Access login's signature,
audience and expiry, the OAuth token, and the caller's role on every tool call.
Remove a person or a service token from the team to cut them off.

## Connect a client

Each workspace has its own address. Use `/mcp` for the `default` workspace and
`/w/<slug>/mcp` for any other. A token works only for the address it was issued
for, so a client for `acme` cannot use `default`.

The person must already be a member of that workspace. A person who is not gets
a page that says so, and nothing is issued.

**Claude Code**

```sh
claude mcp add --transport http support-mcp https://support.example.com/mcp
```

Then run `/mcp` in Claude Code, choose `support-mcp`, and choose **Authenticate**.
It opens the browser. For another workspace, add a second server with
`https://support.example.com/w/acme/mcp` and a different name.

**Codex**

In `~/.codex/config.toml`:

```toml
[mcp_servers.support-mcp]
url = "https://support.example.com/mcp"
tool_timeout_sec = 930
```

Then run `codex mcp login support-mcp`. Older Codex versions need
`experimental_use_rmcp_client = true` for OAuth. `tool_timeout_sec` has to cover
the longest call: a restart, shutdown, install, uninstall or close can wait up
to 5 minutes (300 seconds) for a technician's approval in the technician app,
and then a command can run for up to 600 seconds, the longest `run` timeout,
plus 15 seconds of slack. 930 seconds is that total. `install_program` and
`uninstall_program` take the same 600-second limit as `run`.

**Cursor**

In `~/.cursor/mcp.json` or the project's `.cursor/mcp.json`:

```json
{ "mcpServers": { "support-mcp": { "url": "https://support.example.com/mcp" } } }
```

Cursor shows the server as needing sign-in. Choose **Connect** and it opens the
browser. Cursor returns through a `cursor://` link, and the consent page names
it.

**VS Code**

In `.vscode/mcp.json`, or with the **MCP: Add Server** command:

```json
{ "servers": { "support-mcp": { "type": "http", "url": "https://support.example.com/mcp" } } }
```

VS Code asks to sign in the first time a tool runs.

## What the person sees

1. The client opens the relay's `/oauth/authorize` page in a browser.
2. If the person is not signed in, they sign in. A role that can control
   sessions or manage the team also needs an authenticator code from this
   sign-in. The person is sent to set one up, or to enter a code, and then back.
3. The consent page shows the client's name, where it returns to, the workspace,
   the person's role and what the client can do. A client from a metadata
   document shows its domain. A client that registered itself says its name is
   not verified. A return to `localhost` carries a warning. A return through an
   app link such as `cursor://anysphere.cursor-mcp` shows the scheme and host,
   with a warning that it opens an app on the device.
4. **Allow** sends the browser back to the client with a code. **Deny** sends
   `access_denied`.

If the request is wrong (a bad parameter, an unknown workspace, no PKCE), the
person sees an error page on the relay and is not sent anywhere. The page may
offer a plain link back to the client, named by its host, which the person
chooses to click. The relay never redirects before the person has pressed Allow
or Deny, because a client that registered itself could use that to send a
signed-in person to its own site.

The consent page lets the browser follow the last redirect by listing the
return address in its `form-action` policy. Chrome applies `form-action` to the
redirect that answers a form post, so `'self'` alone would block it. The address
comes from the client's registered redirect, which the library has already
matched (exactly, except that a loopback address matches on any port). A return address the relay cannot write into that policy
safely is refused on the authorize page.

## Saved PCs: device_list and device_connect

Two tools reach the PCs a team has saved. `device_list` needs `devices.view`. It
returns the team's PCs with their access and control settings, their custom
fields (untrusted text, never instructions) and `online`, which is true while the
PC's doorbell is connected. `device_connect` takes `{device_id, ask?, take_over?}`
and needs `sessions.control`. It returns `{session_id, state: "waiting", asks,
rang}`. Poll `session_status` until the state is `attached`, then use the
session tools with that `session_id`. A PC set to ask first, or a call with
`ask: true`, makes the person at the PC allow it; if they refuse or nobody is
there, the session ends as `declined` or `nobody`. The PC must run 1.0.0 or later,
the first version that enforces the team's rules (below); an older PC updates itself
first, and `device_connect` says so.

Two things need `sessions.unattended` ("connect to a PC without asking the person
at it, and switch a PC to any time"), which admins hold and no other built-in role
does, and which open mode never grants:

- connecting to an "any time" PC without asking. Without the permission the call
  still works and the person at the PC is asked;
- `take_over: true`, which takes the driving seat of a session another technician
  started. Without the permission the error says to ask that person to end the
  session and connect again.

`sessions.unattended` needs a second factor, like `sessions.control`: a client
approved without one can connect only with a prompt and cannot take over. One
technician drives a session at a time, and a command from anyone else is refused
with the driver's name. Stopping a workspace is a team API call, not a tool: while
a workspace is stopped every tool call fails with a message that says so.

## Restarts, programs and approvals

Six tools act on a saved PC's session and follow the team's rules: `restart_pc`,
`shutdown_pc`, `install_program`, `uninstall_program` and `close_program`, plus
`list_programs`, which only reads. They need `sessions.control`, like `run`, and work only
in a session on a saved PC. A one-off link refuses them with `not_saved_pc`.

- `restart_pc` and `shutdown_pc` take `{session_id, delay_s?}`, with `delay_s` from 5 to 600
  (default 30). The answer, `{ok: true, at}`, comes before the PC acts, and `at` is when it
  will, in Unix seconds. Do not call again to check or retry: a second call schedules a
  second action. The PC forces open programs closed, so unsaved work is lost.
- `list_programs` returns `installed` (`id`, `name`, `version`, `publisher`) and `running`
  (`name`, `pid`, `session`). Take the ids from it.
- `install_program` takes `{session_id, path, args?, timeout_s?}`: `path` is an installer
  that is already on the PC (send it with `put_file`), `.msi`, `.msu` or `.exe`, not in the Windows
  folder, never a Windows tool such as `shutdown.exe` or `msiexec.exe` and never an uninstaller
  such as `unins000.exe` or `Uninstall.exe`; `args` is at most 1,000
  characters with no line breaks, and arguments that restart the PC or uninstall are refused (use
  `restart_pc` and `uninstall_program`). `uninstall_program`
  takes `{session_id, program_id, timeout_s?}`. `timeout_s` is 10 to 600, default 300. Both
  return `{ok, exit_code}`, with a `detail` note when the installer wrote an error or left
  processes that were stopped, and run as SYSTEM, so the PC must be set to full control.
- `close_program` takes `{session_id, name | pid, force?}` and returns `{ok, closed}`, with
  `still_running` when some of them did not close. Without
  `force` it asks the program to close. With it, the program ends at once and unsaved work is
  lost. The Support app's own processes are never closed (`protected_program`).

The relay checks each action against the rules in force for that PC before anything reaches
it, and the PC checks again. The result is one of three. The action runs. It is refused. Or it
waits for a technician's approval: the call stays open for up to 5 minutes while a member
holding `sessions.unattended` approves or denies it in the technician app, with a fresh code
from their authenticator to approve. The person at the PC is not asked and sees nothing for
these actions. A call that waits can take longer than a `run`, so set your client's tool
timeout to cover it (for Codex, `tool_timeout_sec`, above).

**Errors start with a code,** then a sentence: `<code>: <sentence>`. A refusal is the team's
decision or a technician's, not a fault. Do not retry it, and do not work round it with a raw
`run`: a `run` is not limited by the rules beyond a screen, but that is not permission, and
the screen refuses the obvious command with `use_tool`. The same goes for the other tools:
`install_program` is for installers, so it is not a way to restart the PC or uninstall a program.

| Code | Means |
|---|---|
| `rule_never` | the team's rules never allow this action on this PC |
| `business_hours` | the rules allow it only outside business hours (`outside_hours`) |
| `protected_program`, `protected_folder` | the rules protect that program or folder. Windows' own critical processes are `protected_program` too |
| `needs_full_control` | a restart, shutdown, install or uninstall needs a PC set to full control |
| `declined` | a technician declined, or the approval was cancelled |
| `approval_timeout` | no technician answered in 5 minutes |
| `approval_unavailable` | nobody can approve for this caller: a service token, or a team where no member holds `sessions.unattended` (open mode included) |
| `busy` | another action waits for approval on this session, or a restart or shutdown already waits on the PC. After an approval, if the PC stays busy for a minute the error says the approval was used |
| `rules_stale` | the relay or the PC could not get the team's current rules; try again in a minute |
| `not_found` | no such program, or no installer at that path |
| `not_saved_pc` | the session is a one-off link |
| `needs_update` | the PC runs a version below 1.0.0 |

A service token can use the tools when the rules allow the action without approval, but it cannot
be approved for. The built-in agent has the same six tools and the same rules, and waits for
approval as its starter. Stop or Pause on its task cancels the approval it waits for. In
"built-in agent only" mode these tools answer "this team uses the built-in agent", like the other
session tools. `session_status` shows the PC's `rules` and the `approval` that waits, if any.

Rules are saved through the team API or the technician app's **Rules** screen, never through a
tool, so text on a customer's screen cannot change them. See
[Rules and approvals](../README.md#rules-and-approvals) and the
[security model](security-model.md#rules-and-approvals).

## Working together: people_list, session_participants, session_handover and escalation

Four tools let a technician bring a colleague into a live session, hand control over, and send a session they
cannot finish to the team's queue. They work on a saved PC's session and on a one-off link's. All four need
`sessions.control`, are for real members only (open mode does not count), and an OAuth client passes the same
second factor as for any session tool. The technician app calls the same tools.

- **`people_list`** `{}` returns `{people: [{identity, name, can_control}]}`: members who are people. Use an
  `identity` from it to invite someone who can control sessions.
- **`session_participants`** `{session_id, action, identity?}`. The driver (the one whose commands are accepted)
  calls `invite` with `identity`; the colleague gets a notification and calls `join`, and from then on watches. A
  watcher sends no commands and sees the last full screenshot the driver or the agent took (the app fetches it;
  `session_status` shows `frame_rev` and `frame_at`). `leave` is for a watcher, and the driver `remove`s someone. It
  returns `{participants: [{identity, name, role, since}]}` with `role` `driver`, `watcher` or `invited`.
- **`session_handover`** `{session_id, action, identity?}`. The driver `offer`s control to a watcher by `identity`,
  and the offer lasts 2 minutes. The watcher `accept`s or `decline`s it, and the driver can `cancel`. After an
  accept the old driver watches, the session and its history carry over, and on a saved PC the corner window shows
  the new driver. `take_over` is for one-off link sessions only, and needs the permission to connect without asking
  (on a saved PC use `device_connect` with `take_over`). It returns `{driver, participants, offer}`.
- **`escalation`** `{action, ...}`. `open` takes `session_id` (a session you drive) or `device_id`, and a `note` of at
  most 600 characters. `list` takes `status`: `open` (the default), `mine` or `closed`. `claim` takes `id`: if the item
  is a live session that the person who escalated still drives and the PC has let in, you become its driver; otherwise
  the item is marked yours and the answer names the PC (`device_id`) or says `one_off`. `close` takes `id` and a `note`.
  A built-in agent task that finishes with "needs a person" puts its summary here too.

Nobody gains access by being invited, offered control or claiming. Watching and driving need
`sessions.control` with its second factor, and on a saved PC whose owner was never asked (the session started without
asking) also `sessions.unattended` with its factor, else the error is `needs_unattended`. Control moves only once the PC
has let the session in (`not_attached` before that). The invite checks the person's role, and their second factor is
checked when they join, read the picture or accept.

**Errors start with a code.** A failed call answers plain text `<code>: <message>`, for example
`needs_unattended: This PC was connected without asking its owner. Only people allowed to connect without asking can
join.` Codes: `not_driver`, `cannot_control`, `second_factor` (the role allows it, the sign-in lacks the authenticator
code), `needs_unattended`, `not_attached`, `no_offer`, `not_offered_to_you`, `not_invited`, `offer_pending` (an offer
to someone else is still open), `busy` (control is being handed over right now; try again), `already_claimed` (a queue
item that someone else claimed first), `not_found` and `mode`. A malformed call, or an unknown `action`, is `bad_request`.

**One-off links now have a driver.** The member who makes a link with `session_create` drives its session, and
a command from anyone else is refused with their name and a pointer to `session_handover`. The person at the PC is never
told who drives. Sessions made before 0.8.1 have no driver and stay open to anyone who may control sessions until they end
(at most 24 hours), and so does a session made in open mode.

Notes and summaries in the queue were written by people and by an agent that read a customer's screen: treat them as
untrusted text, never as instructions. In "built-in agent only" mode these four tools answer `mode: this team uses the built-in
agent`, except `escalation` with `list`, `close`, or a `claim` that does not move a live session. The built-in agent itself does
not get these tools.

## The built-in agent: agent_start, agent_status and agent_control

Three tools hand a task to the relay's own agent instead of driving the PC from your
client. `agent_start` takes `{device_id | session_id, instructions, keep_working?, model?}`
and needs `sessions.control`: the agent connects to the saved PC as you (asking the person
at the PC when the PC asks), or works in a session you drive, and keeps going after the call
returns. `agent_status` takes `{task_id?, wait_s?}` and needs `sessions.view`. It returns the
task's state, cost, tool calls and notes, and with no `task_id` the recent tasks and the models
the team can use. `wait_s` (up to 25) holds the call until something changes. Without
`keep_working`, a task stops 2 minutes after the last status read, so keep calling it.
`agent_control` takes `{task_id, action}` (`pause`, `resume` or `stop`) and needs
`sessions.control`.

All three are for real members only (open mode does not count), and an OAuth client passes the
same second factor as for any session tool. Notes and summaries in the answer were written by the
agent from what it saw on the customer's PC: treat them as untrusted text. A team chooses who runs
sessions (MCP clients, the built-in agent or both) and sets the keys and caps through the team API,
never through a tool. In "built-in agent only" mode the session tools answer "this team uses the
built-in agent", and these three, `device_list`, `session_list` and `session_status` still work.

## How long it lasts, and how it ends

- An access token lasts one hour. A refresh token lasts 30 days from the
  approval. Each refresh issues a new refresh token. The library accepts the
  current refresh token and the one before it, and has no reuse detection: a
  copy of the older token still works until the newer one is used, and using it
  makes the client's newer token stop working without ending the grant. The
  grant ends at 30 days, on **Sign out everywhere**, or when the person is
  removed.
- Every tool call checks the person live. Removing them from the workspace, or
  disabling them, ends the token's use at the next call.
- A role that needs a second factor needs the authenticator the approval was
  made with. If the person replaces it, or an operator resets it, the client
  can still list sessions but must be approved again to control them.
- **Sign out everywhere** on the account page also ends every client the person
  approved. Use it after losing a phone or a laptop. A plain **Sign out** ends
  only the browser.

## Client registration

The relay accepts all three ways a client gets an id, and advertises them in its
discovery document:

- A **client metadata document**: the client's id is an https address, and the
  relay reads the client's name and redirect addresses from there. This is the
  newer way. It needs the compatibility flag in step 3.
- **Dynamic registration** at `/oauth/register`: older clients register
  themselves. Anyone can call it. A flood of registrations uses up the KV
  write limit below, so add a Cloudflare rate-limiting rule on `/oauth/` (for
  example 20 requests a minute per IP).

Registration is not limited to public clients. A client that names no
authentication method is registered with a client secret. So the relay requires
PKCE with S256 on every authorization request, whatever the client type, and
refuses a request without it. Redirect addresses match the registration exactly,
except that a loopback address (`127.0.0.1`, `[::1]` or `localhost`) matches on any
port, as RFC 8252 says: the scheme, host, path and query must be the registered ones, and
a client may register `http://127.0.0.1/callback` and use a free port at each sign-in. Redirect addresses may be
`https`, `http` on the loopback address, or an app link such as `cursor://`
(RFC 8252). Dangerous schemes (`javascript:`, `data:`, `file:` and similar) are
refused at registration, and the authorize page refuses any scheme it cannot
write into its `form-action` policy.

## Free-plan KV limits

OAuth data is in Workers KV. On the free plan KV allows 100,000 reads and 1,000
writes a day. Check Cloudflare's KV limits page for the current numbers,
including deletes and lists.

- Each OAuth tool call is one read. So are `tools/list`, `initialize` and `ping`
  when they carry a token. A request with no token reads nothing.
- A bearer token is checked before KV is read. It must have the shape the relay
  issues, and its first part must name a person who exists and is enabled in the
  database (one D1 read; the D1 free plan allows far more reads than KV). A
  junk token fails there with 401 and costs no KV read. A person you disable
  stops using KV at once.
- Each client writes two keys each time its access token is refreshed, once an
  hour while it is connected: 48 writes a day for a client that is active
  around the clock. About 20 such clients use the 1,000 free writes. A new
  connection writes about five keys: the client, the consent step, the code,
  the token and the grant update.
- Past a limit KV refuses the call, and OAuth calls fail until 00:00 UTC. The
  relay answers 503 (not 401), so the client keeps its sign-in and retries. An
  Access login or service token keeps working. Workers Paid lifts the limits.
- The technician app's token (for `/app/w/<slug>`, not an MCP address) also reads KV
  once per call, but the relay remembers a token it has just checked for 60 seconds, so
  a busy app costs about one read a minute. The app's feed and its open session tabs
  cost Worker requests instead: about 3,500 feed calls a day for one person, and about
  1,800 requests an hour for each open session tab, against 100,000 requests a day on
  the free plan.
- The checks above stop junk tokens before KV, but each still costs a request
  and a database read. Add a Cloudflare rate-limiting rule on `/mcp`, `/w/*`
  and `/app/*` as well as `/oauth/`.

KV is eventually consistent. A write reaches other locations within about a
minute. Two things follow:

- A one-time authorization code that has been used might still work once more
  at a location that has not seen the change. The library marks a code used on
  its first exchange, refuses a replay, and ends the grant when it sees one. The
  codes live for ten minutes and need the client's PKCE verifier.
- **Sign out everywhere** deletes grants from KV. A location holding a copy can
  accept the token for up to about a minute. Removing a person from a team has no such
  delay, because that check reads D1 on every call.

## Many workspaces

The technician app's addresses (`/app/w/<slug>`) are not in this list. A request for one
builds a server that declares only that address, so they add nothing to the build time below.

The relay builds the list of MCP addresses from the database every ten seconds,
so a new workspace works without a deploy. It also reads the list again at once
when the authorize page is asked for an address it does not have, and when
`/oauth/token` refuses a request and the list has changed since it was read (at
most once every two seconds). So a person can approve a client, and the client
can exchange its code in another Worker instance, right after a workspace is
created. The OAuth library checks the list pairwise, which costs about a third
of a second of CPU at 500 workspaces. Creating a workspace past 500 is refused
with `409` and the error code `workspace_limit`, so the list is never cut short.
A deployment with far more would need a different design.

The authorization server document does not list the workspace addresses, so it
does not publish your team names. The slugs are not secret, though: the protected
resource document for `/w/<slug>/mcp` answers 200 for a workspace that exists
and 404 for one that does not, to anyone. Do not put anything in a slug you would
not say aloud.

## Try it locally

Run the relay with `wrangler dev` as described in
[Sign-in locally](development.md#sign-in-locally), and do not set
`DEV_SKIP_ACCESS`. With it set every local caller is accepted without a token, so
the client is never asked to sign in. Local KV needs no id.

```sh
claude mcp add --transport http local-support http://localhost:8787/mcp
```

Run `/mcp` in Claude Code and choose **Authenticate**. The browser opens the
relay's consent page. Sign in with the emailed link that `DEV_SHOW_EMAIL_LINKS=1`
shows on the page.

## Addresses

| Address | What it is |
|---|---|
| `GET /.well-known/oauth-authorization-server` | the authorization server's document (RFC 8414) |
| `GET /.well-known/oauth-protected-resource`, `.../mcp`, `.../w/<slug>/mcp` | the protected resource documents (RFC 9728); 404 for a workspace that does not exist |
| `GET` and `POST /oauth/authorize` | the consent page |
| `POST /oauth/token` | code exchange, refresh and revocation |
| `POST /oauth/register` | dynamic client registration |

A request to an MCP address with no credential, or a token that fails (expired,
revoked, for another address, malformed), gets 401 with `WWW-Authenticate: Bearer
resource_metadata="..."`, which is how a client finds all of the above. A failed
token also carries `error="invalid_token"`.
