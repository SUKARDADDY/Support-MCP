// support-mcp relay Worker entry: wires the router (src/app.js) to the
// PowerShell agent template and the compiled Windows app bundle, and exports the
// Durable Object classes. Customer paths (/healthz, /j/<code>, /agent, /ws) are
// public. /mcp and the team API (/api/) admit Access logins and service tokens,
// and /mcp (and /w/<slug>/mcp) also admit OAuth tokens that MCP clients obtain
// through /oauth/*.
//
// The OAuth library is imported here and nowhere else. It imports
// `cloudflare:workers`, which only workerd can load, so the router takes what it
// needs as an argument and Node tests can load the router on its own.
import {
  AuthorizationError, CimdFetchError, OAuthAuthorizationServer,
} from '@cloudflare/workers-oauth-provider';
import AGENT_PS1 from './agent.ps1';
import APP_BUNDLE from './app-bundle.json';
import { Session } from './session.js';
import { Registry } from './registry.js';
import { AgentTask } from './agent-task.js';
import { createHandler } from './app.js';

export { Session, Registry, AgentTask };

export default createHandler(AGENT_PS1, APP_BUNDLE, {
  oauth: { OAuthAuthorizationServer, AuthorizationError, CimdFetchError },
});
