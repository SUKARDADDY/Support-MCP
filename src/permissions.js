// Team permissions: the permission keys, the three built-in roles, and which
// permission each MCP tool needs. Pure data and checks, no storage.
//
// Controlling a session (sessions.control) is administrator-level on a
// full-control session: file transfers there run as SYSTEM and screen control
// can click Yes on a UAC prompt. There is no separate SYSTEM permission.

export const PERMISSIONS = Object.freeze([
  'members.manage',
  'roles.manage',
  'audit.view',
  'devices.view',
  'devices.manage',
  'fields.manage',
  'sessions.create',
  'sessions.view',
  'sessions.control',
  'sessions.end',
  'sessions.unattended',
]);

export const ADMIN_ROLE = 'admin';

// sessions.unattended: connect to a saved PC without asking the person at it,
// and switch a PC to "any time". It is the one sessions.* key that open mode
// never grants, so it is named here and not left to the prefix rule below.
export const UNATTENDED_PERMISSION = 'sessions.unattended';

// What any Access caller holds while the workspace has no members: the session
// tools, as before teams existed. Changing the team is not among them, and
// neither is connecting to a saved PC without asking.
export const OPEN_PERMISSIONS = Object.freeze(PERMISSIONS.filter((key) => key.startsWith('sessions.') && key !== UNATTENDED_PERMISSION));

// Built-in roles. admin is fixed. technician and viewer are defaults a
// workspace can edit, or delete while no member holds them.
export const BUILTIN_ROLES = Object.freeze({
  admin: Object.freeze({ name: 'Admin', permissions: PERMISSIONS }),
  technician: Object.freeze({
    name: 'Technician',
    permissions: Object.freeze(['devices.view', 'devices.manage', 'sessions.create', 'sessions.view', 'sessions.control', 'sessions.end']),
  }),
  viewer: Object.freeze({ name: 'Viewer', permissions: Object.freeze(['audit.view', 'devices.view', 'sessions.view']) }),
});

// Permissions that need a second factor when the caller is signed in as
// themselves in a browser, or through OAuth consent: controlling a session,
// managing the team, managing saved PCs and custom fields, and connecting to a
// PC without asking the person at it. A role that
// holds any of them makes its members enrol an authenticator (factorRequired
// in src/auth.js), and the browser sign-in and the OAuth consent page ask for a
// code before they act on that role. Access logins and service tokens are
// exempt: this is a rule for the sign-in layer (src/auth.js). That includes
// devices.manage and fields.manage, so a person whose role holds either must
// enrol an authenticator even though the team API itself admits only Access
// logins today.
export const FACTOR_PERMISSIONS = Object.freeze(['sessions.control', 'members.manage', 'roles.manage', 'devices.manage', 'fields.manage', UNATTENDED_PERMISSION]);
export const needsSecondFactor = (permission) => FACTOR_PERMISSIONS.includes(permission);

export const ROLE_ID_RE = /^[a-z0-9-]{1,40}$/;

export const isPermission = (key) => typeof key === 'string' && PERMISSIONS.includes(key);
export const isBuiltinRole = (id) => Object.hasOwn(BUILTIN_ROLES, id);

// A role's permission list from the request body: known keys only, no repeats,
// in the canonical order. Throws on anything else.
export function normalizePermissions(list) {
  if (!Array.isArray(list)) throw new Error('permissions must be a list of permission keys');
  for (const key of list) {
    if (!isPermission(key)) throw new Error(`unknown permission: ${String(key).slice(0, 60)}`);
  }
  return PERMISSIONS.filter((key) => list.includes(key));
}

// Every tool the MCP endpoint offers, and the permission it needs. A tool that
// is not here is refused, and test/workspace.test.js fails for any tool from
// listTools() that is missing.
const TOOL_PERMISSIONS = Object.freeze({
  session_create: 'sessions.create',
  session_list: 'sessions.view',
  session_status: 'sessions.view',
  session_end: 'sessions.end',
  run: 'sessions.control',
  put_file: 'sessions.control',
  get_file: 'sessions.control',
  screenshot: 'sessions.control',
  click: 'sessions.control',
  move_mouse: 'sessions.control',
  drag: 'sessions.control',
  scroll: 'sessions.control',
  type_text: 'sessions.control',
  press_key: 'sessions.control',
  wait: 'sessions.control',
  zoom: 'sessions.control',
  ui_tree: 'sessions.control',
  ui_act: 'sessions.control',
  block_input: 'sessions.control',
  send_sas: 'sessions.control',
  type_secret: 'sessions.control',
  request_full_control: 'sessions.control',
  // Listing saved PCs reads the team's records. Connecting needs sessions.control;
  // connecting without asking, and taking over, check sessions.unattended inside
  // the tool and again when the claim commits.
  device_list: 'devices.view',
  device_connect: 'sessions.control',
});

// The permission a tool call needs, or null for a tool this table does not know.
export function permissionForTool(name) {
  return typeof name === 'string' && Object.hasOwn(TOOL_PERMISSIONS, name) ? TOOL_PERMISSIONS[name] : null;
}
