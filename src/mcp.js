// MCP JSON-RPC 2.0 dispatch, kept pure so node --test can drive it with a fake
// backend. index.js supplies a backend that talks to the Durable Objects.

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26'];
export const DEFAULT_PROTOCOL = '2025-06-18';
export const SERVER_INFO = { name: 'support-mcp', version: 'relay-v1' };

export const TOOLS = [
  {
    name: 'session_create',
    description: 'Create a support session and return the one-liner the customer pastes.',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string', description: 'optional human label' } },
    },
  },
  {
    name: 'session_list',
    description: 'List support sessions with state, expiry and machine.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'session_status',
    description: 'State, machine, user, expiry, whether an agent is attached, and the last log rows.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        log_tail: { type: 'integer', description: 'rows of audit log (default 20)' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'run',
    description:
      'Run a PowerShell command on the customer machine (as the signed-in user, never elevated). Returns exit_code (null if it timed out and was killed), stdout, stderr (plain text, each may end with [truncated]), timed_out.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        command: { type: 'string' },
        timeout_s: { type: 'integer', description: '1..600, default 60' },
      },
      required: ['session_id', 'command'],
    },
  },
  {
    name: 'put_file',
    description:
      'Write bytes (base64) to an absolute path on the customer machine. At most 700000 base64 chars per call; for larger files send the first chunk with append:false and each further chunk with append:true.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        path: { type: 'string' },
        data_b64: { type: 'string', description: 'base64, max 700000 chars per call' },
        append: { type: 'boolean', description: 'append to the file instead of replacing it' },
      },
      required: ['session_id', 'path', 'data_b64'],
    },
  },
  {
    name: 'get_file',
    description:
      'Read bytes (base64) from an absolute path on the customer machine. At most 524288 bytes per call; read larger files in chunks by advancing offset until eof is true (size is the total file size).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        path: { type: 'string' },
        offset: { type: 'integer', description: 'byte offset, default 0' },
        length: { type: 'integer', description: 'bytes to read, max (and default) 524288' },
      },
      required: ['session_id', 'path'],
    },
  },
  {
    name: 'session_end',
    description: 'End a session: tells the agent to clean up, then marks it ended.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
];

export function negotiateProtocol(requested) {
  return SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL;
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const textResult = (obj) => ({
  content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }],
});
const toolError = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

// backend: { session_create, session_list, session_status, run, put_file,
//            get_file, session_end } each async (args) -> object|string, may throw.
// Returns { status, body } where body is the JSON-RPC response object, or null
// for notifications (202 no body).
export async function handleRpc(msg, backend) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { status: 200, body: rpcError(msg && msg.id != null ? msg.id : null, -32600, 'invalid request') };
  }
  const { method, id } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = msg.params && msg.params.protocolVersion;
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiateProtocol(requested),
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      };
    }
    case 'notifications/initialized':
      return { status: 202, body: null };
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      const fn = backend[name];
      if (typeof fn !== 'function') {
        return { status: 200, body: rpcResult(id, toolError(`unknown tool: ${name}`)) };
      }
      try {
        const out = await fn(args);
        return { status: 200, body: rpcResult(id, textResult(out)) };
      } catch (e) {
        return { status: 200, body: rpcResult(id, toolError(String(e && e.message ? e.message : e))) };
      }
    }
    default:
      if (isNotification) return { status: 202, body: null };
      return { status: 200, body: rpcError(id, -32601, `method not found: ${method}`) };
  }
}
