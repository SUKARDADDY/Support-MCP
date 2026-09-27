// support-mcp relay Worker entry: wires the router (src/app.js) to the
// PowerShell agent template and exports the Durable Object classes.
// Customer paths (/healthz, /j/<code>, /ws) are public; /mcp is behind Access.
import AGENT_PS1 from './agent.ps1';
import { Session } from './session.js';
import { Registry } from './registry.js';
import { createHandler } from './app.js';

export { Session, Registry };

export default createHandler(AGENT_PS1);
