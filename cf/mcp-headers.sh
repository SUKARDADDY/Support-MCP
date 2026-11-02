#!/usr/bin/env bash
# Headers helper for the support-mcp MCP server (Claude Code headersHelper,
# Codex http_headers_helper): prints the Access service-token headers as JSON,
# read at connect time from the env file written by cf/access-setup.sh, so the
# secret never lands in the client's config file.
set -euo pipefail
set -a; . "${SUPPORT_MCP_ENV:-$HOME/.config/support-mcp/access.env}"; set +a
python3 -c 'import json,os; print(json.dumps({"CF-Access-Client-Id": os.environ["CF_ACCESS_CLIENT_ID"], "CF-Access-Client-Secret": os.environ["CF_ACCESS_CLIENT_SECRET"]}))'
