#!/usr/bin/env bash
# Provision the Cloudflare Access guard for the relay's MCP endpoint and team API.
#
# Creates (idempotently, by name):
#   - Access service token  "support-mcp-client"  -> credentials for the MCP client
#   - Access application    "support-mcp"         -> <host>/mcp, <host>/w/* and <host>/api  (self-hosted)
#       policy 1 "operator"       allow   email == $SUPPORT_OPERATOR_EMAIL  (browser / OTP)
#       policy 2 "mcp-client"     service_auth  the service token above
# /w/* is the MCP endpoint of each created workspace (/w/<slug>/mcp). The pattern
# has the slash, so it does not cover /ws.
# Customer paths (/j/<code>, /ws, /healthz) are NOT under the app and stay public.
#
# OAUTH=1 is for a relay that signs MCP clients in with its own OAuth server
# (docs/mcp-clients.md). The relay answers /mcp itself with a Bearer challenge, so
# an Access redirect in front of it would stop an MCP client from ever reaching its
# sign-in. In this mode there are two Access applications:
#   - "support-mcp"      <host>/api only: operator (browser) and the service token,
#                        exactly as above.
#   - "support-mcp-mcp"  <host>/mcp and <host>/w/*, with two policies in this order:
#       policy 1 "mcp-client"  service_auth  the same service token
#       policy 2 "everyone"    bypass        everyone
#     Cloudflare evaluates Bypass and Service Auth policies first, top to bottom.
#     A request that carries the service token gets an Access JWT, so service
#     tokens keep working on the MCP addresses. Every other request (an OAuth
#     bearer, discovery, no credential) passes to the relay, which checks it.
#     Print this app's AUD and put it in wrangler.toml as ACCESS_MCP_AUD. The relay
#     accepts a JWT for either application on the MCP addresses only.
# These addresses stay outside Access altogether, because the relay answers them:
#   /oauth/  /.well-known/  /auth/  /account
# Access session revocation does not apply on the bypassed paths. There the relay's
# own checks are the gate. Do not also turn on Access "Managed OAuth" for those
# addresses: it would answer the same discovery requests with a different
# authorization server. Leave OAUTH unset to put Access in front of /mcp and /w/*.
# Switching back (OAUTH unset) deletes the "support-mcp-mcp" application, so the
# two never claim the same address.
#
# Needs an API token on the account with:  Access: Apps and Policies (Edit),
# Access: Service Tokens (Edit).
#
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
#   SUPPORT_HOST=support.example.com SUPPORT_OPERATOR_EMAIL=you@example.com \
#   [OAUTH=1] cf/access-setup.sh
#
# The service token's client secret is shown ONCE by the API; the script writes
# it to $SUPPORT_MCP_ENV (default ~/.config/support-mcp/access.env, mode 600)
# and never prints it. The AUD tag of each application is printed; put it in
# wrangler.toml as ACCESS_AUD (and ACCESS_MCP_AUD with OAUTH=1).
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${SUPPORT_HOST:?set SUPPORT_HOST, e.g. support.example.com}"
: "${SUPPORT_OPERATOR_EMAIL:?set SUPPORT_OPERATOR_EMAIL}"
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access"
HOST="$SUPPORT_HOST"; APP_NAME="support-mcp"; MCP_APP_NAME="support-mcp-mcp"; ST_NAME="support-mcp-client"
OAUTH="${OAUTH:-0}"
case "$OAUTH" in 0|1) ;; *) echo "OAUTH must be 1 or unset" >&2; exit 2 ;; esac
# The addresses the main Access application covers. The first is the app's main domain.
if [ "$OAUTH" = 1 ]; then
  MAIN_DOMAIN="$HOST/api"; DOMAINS="[\"$HOST/api\"]"
else
  MAIN_DOMAIN="$HOST/mcp"; DOMAINS="[\"$HOST/mcp\",\"$HOST/w/*\",\"$HOST/api\"]"
fi
OWNER="$SUPPORT_OPERATOR_EMAIL"; ENV_OUT="${SUPPORT_MCP_ENV:-$HOME/.config/support-mcp/access.env}"
# The token goes to curl through a config file read from a process substitution
# (printf is a builtin), so it never appears in argv or in `ps` output.
cf() { curl -sS -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") -H "content-type: application/json" "$@"; }
# Reads the create-token API response on stdin and writes the env file. umask only
# sets the mode of a file the shell creates, so an existing 0644 file would keep
# it: remove the old file first, write under umask 077, then chmod 600 anyway.
# The secret travels only through the pipe and the file, never argv.
write_env_file() {
  rm -f "$ENV_OUT"
  ( umask 077
    HOST="$HOST" python3 -c 'import os,sys,json; r=json.load(sys.stdin)["result"]; print("# Cloudflare Access service token for the MCP client on %s/mcp\n# Send as headers CF-Access-Client-Id / CF-Access-Client-Secret. Created by cf/access-setup.sh.\nCF_ACCESS_CLIENT_ID=%s\nCF_ACCESS_CLIENT_SECRET=%s" % (os.environ["HOST"], r["client_id"], r["client_secret"]))' > "$ENV_OUT" )
  chmod 600 "$ENV_OUT"
}
ok() { python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else (print(json.dumps(d.get("errors")), file=sys.stderr) or 1))'; }

# 1. service token (create only if absent; the secret is unrecoverable later)
ST_ID=$(cf "$API/service_tokens" | python3 -c "import sys,json; print(next((t['id'] for t in json.load(sys.stdin)['result'] or [] if t['name']=='$ST_NAME'),''))")
if [ -z "$ST_ID" ]; then
  RESP=$(cf -X POST "$API/service_tokens" --data "{\"name\":\"$ST_NAME\",\"duration\":\"8760h\"}")
  echo "$RESP" | ok
  ST_ID=$(echo "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["id"])')
  umask 077; mkdir -p "$(dirname "$ENV_OUT")"
  echo "$RESP" | write_env_file
  echo "service token created: $ST_ID (secret written to $ENV_OUT)"
else
  echo "service token exists: $ST_ID (secret unchanged; rotate via dashboard if lost)"
fi

# 2. applications. app_id NAME prints the id of the application with that name, or nothing.
app_id() { cf "$API/apps" | python3 -c "import sys,json; print(next((a['id'] for a in json.load(sys.stdin)['result'] or [] if a.get('name')=='$1'),''))"; }
# upsert_app NAME BODY creates or updates the application and prints its id.
upsert_app() {
  local id resp
  id=$(app_id "$1")
  if [ -z "$id" ]; then
    resp=$(cf -X POST "$API/apps" --data "$2"); echo "$resp" | ok
    id=$(echo "$resp" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["id"])'); echo "app created: $1 $id" >&2
  else
    cf -X PUT "$API/apps/$id" --data "$2" | ok; echo "app updated: $1 $id" >&2
  fi
  echo "$id"
}
aud_of() { cf "$API/apps/$1" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["aud"])'; }
BODY=$(cat <<JSON
{"name":"$APP_NAME","type":"self_hosted","domain":"$MAIN_DOMAIN","self_hosted_domains":$DOMAINS,
 "session_duration":"24h","app_launcher_visible":false,"allowed_idps":[],"auto_redirect_to_identity":false,
 "http_only_cookie_attribute":true,"same_site_cookie_attribute":"lax",
 "policies":[
   {"name":"operator","decision":"allow","precedence":1,"include":[{"email":{"email":"$OWNER"}}]},
   {"name":"mcp-client","decision":"non_identity","precedence":2,"include":[{"service_token":{"token_id":"$ST_ID"}}]}
 ]}
JSON
)
APP_ID=$(upsert_app "$APP_NAME" "$BODY")
printf 'ACCESS_AUD for wrangler.toml: %s\n' "$(aud_of "$APP_ID")"
MCP_APP_ID=$(app_id "$MCP_APP_NAME")
if [ "$OAUTH" = 1 ]; then
  # The MCP addresses: the service token gets a JWT, everyone else passes through.
  MCP_BODY=$(cat <<JSON
{"name":"$MCP_APP_NAME","type":"self_hosted","domain":"$HOST/mcp","self_hosted_domains":["$HOST/mcp","$HOST/w/*"],
 "session_duration":"24h","app_launcher_visible":false,"allowed_idps":[],"auto_redirect_to_identity":false,
 "http_only_cookie_attribute":true,"same_site_cookie_attribute":"lax",
 "policies":[
   {"name":"mcp-client","decision":"non_identity","precedence":1,"include":[{"service_token":{"token_id":"$ST_ID"}}]},
   {"name":"everyone","decision":"bypass","precedence":2,"include":[{"everyone":{}}]}
 ]}
JSON
)
  MCP_APP_ID=$(upsert_app "$MCP_APP_NAME" "$MCP_BODY")
  printf 'ACCESS_MCP_AUD for wrangler.toml: %s\n' "$(aud_of "$MCP_APP_ID")"
elif [ -n "$MCP_APP_ID" ]; then
  # Back to one application: the second would claim the same addresses.
  cf -X DELETE "$API/apps/$MCP_APP_ID" | ok; echo "app removed: $MCP_APP_NAME $MCP_APP_ID"
fi

# 3. prove it
sleep 3
code() { curl -s -o /dev/null -w '%{http_code}' "https://$HOST$1"; }
# /mcp refuses anything but a JSON POST before it looks at a credential.
post_code() { curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' "https://$HOST$1"; }
printf 'unauth /api -> %s (expect 302/401/403)\n' "$(code /api/v1/w/default)"
printf '/healthz     -> %s (expect 200)\n' "$(code /healthz)"
if [ "$OAUTH" = 1 ]; then
  # The relay answers these itself: 401 with a Bearer challenge, and open discovery.
  # A service token on /mcp is not tested here: its secret is not printed. Call /mcp
  # with CF-Access-Client-Id and CF-Access-Client-Secret from $ENV_OUT to confirm it.
  printf 'unauth /mcp -> %s (expect 401 from the relay, not a redirect)\n' "$(post_code /mcp)"
  printf 'unauth /w/x/mcp -> %s (expect 401)\n' "$(post_code /w/x/mcp)"
  printf '/.well-known/oauth-authorization-server -> %s (expect 200)\n' "$(code /.well-known/oauth-authorization-server)"
  printf '/.well-known/oauth-protected-resource/mcp -> %s (expect 200)\n' "$(code /.well-known/oauth-protected-resource/mcp)"
  printf '/auth/signin -> %s (expect 200 or 503 until AUTH_SECRET is set)\n' "$(code /auth/signin)"
else
  # <host>/mcp, <host>/w/<slug>/mcp and <host>/api must be redirected/denied by Access.
  printf 'unauth /mcp -> %s (expect 302/401/403)\n' "$(code /mcp)"
  printf 'unauth /w/x/mcp -> %s (expect 302/401/403)\n' "$(code /w/x/mcp)"
fi
