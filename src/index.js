// support-mcp relay Worker entry: wires the router (src/app.js) to the
// PowerShell agent template and the compiled Windows app bundle, and exports the
// Durable Object classes. Customer paths (/healthz, /j/<code>, /agent, /ws) are
// public; /mcp and the team API (/api/) are behind Access and the team's roles.
import AGENT_PS1 from './agent.ps1';
import APP_BUNDLE from './app-bundle.json';
import { Session } from './session.js';
import { Registry } from './registry.js';
import { createHandler } from './app.js';

export { Session, Registry };

export default createHandler(AGENT_PS1, APP_BUNDLE);
