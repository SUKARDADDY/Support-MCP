#!/usr/bin/env bash
# headersHelper for Claude Code's support-mcp MCP server: prints the Access
# service-token headers as JSON, read at connect time from the env file written
# by cf/access-setup.sh, so the secret never lands in ~/.claude.json.
set -euo pipefail
set -a; . "${SUPPORT_MCP_ENV:-$HOME/.config/support-mcp/access.env}"; set +a
python3 -c 'import json,os; print(json.dumps({"CF-Access-Client-Id": os.environ["CF_ACCESS_CLIENT_ID"], "CF-Access-Client-Secret": os.environ["CF_ACCESS_CLIENT_SECRET"]}))'
