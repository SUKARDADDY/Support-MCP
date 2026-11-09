// The only module that talks to the Rust core. Every call goes through a Tauri command from
// the list in src-tauri/src/command_list.rs; the screens never reach the relay themselves.
// Tests pass App a stand-in with the same functions.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// A failure from the core arrives as { code, message, status }.
export function errorInfo(e) {
  if (e && typeof e === 'object' && typeof e.message === 'string') return { code: e.code ?? 'internal', message: e.message, status: e.status ?? null };
  return { code: 'internal', message: typeof e === 'string' ? e : 'Something went wrong.', status: null };
}

export const realCore = {
  appInfo: () => invoke('app_info'),
  accounts: () => invoke('accounts_list'),
  signIn: (relay, team) => invoke('sign_in', { relay, team }),
  signInCancel: () => invoke('sign_in_cancel'),
  signOut: (account) => invoke('sign_out', { account }),
  // A call to a relay route under /app/w/<team> (the core refuses routes the app does not use).
  request: (account, method, path, body = null) => invoke('relay_request', { account, method, path, body }),
  // One MCP tool: resolves to { data, image }.
  tool: (account, name, args = {}) => invoke('relay_tool', { account, name, args }),
  recentNotifications: () => invoke('notifications_recent'),
  prefs: () => invoke('prefs_get'),
  setPrefs: (prefs) => invoke('prefs_set', { prefs }),
  // Calls whose commands arrive with the platform and update work; absent, they resolve to null.
  autostart: () => optional('autostart_get'),
  setAutostart: (enabled) => optional('autostart_set', { enabled }),
  updateStatus: () => optional('update_status'),
  checkForUpdate: () => optional('update_check'),
  // Subscribes to a core event; resolves to a function that stops listening.
  on: (event, handler) => listen(event, (e) => handler(e.payload)),
};

async function optional(command, args) {
  try {
    return await invoke(command, args);
  } catch (e) {
    if (String(e?.message ?? e).includes('not found') || String(e).includes('not allowed')) return null;
    throw e;
  }
}
