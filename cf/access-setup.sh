#!/usr/bin/env bash
# Provision the Cloudflare Access guard for the relay's MCP endpoint.
#
# Creates (idempotently, by name):
#   - Access service token  "support-mcp-client"  -> credentials for the MCP client
#   - Access application    "support-mcp"         -> <host>/mcp  (self-hosted)
#       policy 1 "operator"       allow   email == $SUPPORT_OPERATOR_EMAIL  (browser / OTP)
#       policy 2 "mcp-client"     service_auth  the service token above
# Customer paths (/j/<code>, /ws, /healthz) are NOT under the app and stay public.
#
# Needs an API token on the account with:  Access: Apps and Policies (Edit),
# Access: Service Tokens (Edit).
#
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
#   SUPPORT_HOST=support.example.com SUPPORT_OPERATOR_EMAIL=you@example.com \
#   cf/access-setup.sh
#
# The service token's client secret is shown ONCE by the API; the script writes
# it to $SUPPORT_MCP_ENV (default ~/.config/support-mcp/access.env, mode 600)
# and never prints it. Print the app's AUD tag with the last step and put it in
# wrangler.toml as ACCESS_AUD.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${SUPPORT_HOST:?set SUPPORT_HOST, e.g. support.example.com}"
: "${SUPPORT_OPERATOR_EMAIL:?set SUPPORT_OPERATOR_EMAIL}"
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/access"
HOST="$SUPPORT_HOST"; APP_NAME="support-mcp"; ST_NAME="support-mcp-client"
OWNER="$SUPPORT_OPERATOR_EMAIL"; ENV_OUT="${SUPPORT_MCP_ENV:-$HOME/.config/support-mcp/access.env}"
# The token goes to curl through a config file read from a process substitution
# (printf is a builtin), so it never appears in argv or in `ps` output.
cf() { curl -sS -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") -H "content-type: application/json" "$@"; }
ok() { python3 -c 'import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else (print(json.dumps(d.get("errors")), file=sys.stderr) or 1))'; }

# 1. service token (create only if absent; the secret is unrecoverable later)
ST_ID=$(cf "$API/service_tokens" | python3 -c "import sys,json; print(next((t['id'] for t in json.load(sys.stdin)['result'] or [] if t['name']=='$ST_NAME'),''))")
if [ -z "$ST_ID" ]; then
  RESP=$(cf -X POST "$API/service_tokens" --data "{\"name\":\"$ST_NAME\",\"duration\":\"8760h\"}")
  echo "$RESP" | ok
  ST_ID=$(echo "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["id"])')
  umask 077; mkdir -p "$(dirname "$ENV_OUT")"
  echo "$RESP" | HOST="$HOST" python3 -c 'import os,sys,json; r=json.load(sys.stdin)["result"]; print("# Cloudflare Access service token for the MCP client on %s/mcp\n# Send as headers CF-Access-Client-Id / CF-Access-Client-Secret. Created by cf/access-setup.sh.\nCF_ACCESS_CLIENT_ID=%s\nCF_ACCESS_CLIENT_SECRET=%s" % (os.environ["HOST"], r["client_id"], r["client_secret"]))' > "$ENV_OUT"
  echo "service token created: $ST_ID (secret written to $ENV_OUT)"
else
  echo "service token exists: $ST_ID (secret unchanged; rotate via dashboard if lost)"
fi

# 2. application
APP_ID=$(cf "$API/apps" | python3 -c "import sys,json; print(next((a['id'] for a in json.load(sys.stdin)['result'] or [] if a.get('name')=='$APP_NAME'),''))")
BODY=$(cat <<JSON
{"name":"$APP_NAME","type":"self_hosted","domain":"$HOST/mcp","self_hosted_domains":["$HOST/mcp"],
 "session_duration":"24h","app_launcher_visible":false,"allowed_idps":[],"auto_redirect_to_identity":false,
 "http_only_cookie_attribute":true,"same_site_cookie_attribute":"lax",
 "policies":[
   {"name":"operator","decision":"allow","precedence":1,"include":[{"email":{"email":"$OWNER"}}]},
   {"name":"mcp-client","decision":"non_identity","precedence":2,"include":[{"service_token":{"token_id":"$ST_ID"}}]}
 ]}
JSON
)
if [ -z "$APP_ID" ]; then
  RESP=$(cf -X POST "$API/apps" --data "$BODY"); echo "$RESP" | ok
  APP_ID=$(echo "$RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["id"])'); echo "app created: $APP_ID"
else
  cf -X PUT "$API/apps/$APP_ID" --data "$BODY" | ok; echo "app updated: $APP_ID"
fi
printf 'ACCESS_AUD for wrangler.toml: %s\n' "$(cf "$API/apps/$APP_ID" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["aud"])')"

# 3. prove it: unauthenticated /mcp must be redirected/denied by Access, /healthz must stay open
sleep 3
printf 'unauth /mcp -> %s (expect 302/401/403)\n' "$(curl -s -o /dev/null -w '%{http_code}' https://$HOST/mcp)"
printf '/healthz     -> %s (expect 200)\n' "$(curl -s -o /dev/null -w '%{http_code}' https://$HOST/healthz)"
