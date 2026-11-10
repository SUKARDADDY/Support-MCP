// How the Devices screen sorts, filters and names saved PCs. Pure functions over the shapes
// api.js returns.

export const FILTERS = ['all', 'online', 'offline', 'waiting', 'any', 'ask'];

const matches = (d, filter) => {
  switch (filter) {
    case 'all': return true;
    case 'online': return d.status === 'active' && d.online;
    case 'offline': return d.status === 'active' && !d.online;
    case 'waiting': return d.status === 'pending';
    case 'any': return d.status === 'active' && d.access === 'any';
    case 'ask': return d.status === 'active' && d.access === 'ask';
    default: return true;
  }
};

export const siteOf = (device, places) => places.get(device.siteId) ?? null;

// The text under a PC's name: its site, else its customer's name, else nothing.
export const placeLabel = (device, places) => siteOf(device, places)?.name ?? '';

export function filterDevices(devices, places, query, filter) {
  const q = query.trim().toLowerCase();
  return devices.filter((d) => {
    if (!matches(d, filter)) return false;
    if (!q) return true;
    const site = siteOf(d, places);
    return `${d.name} ${site?.name ?? ''} ${site?.customer ?? ''}`.toLowerCase().includes(q);
  });
}

export const filterCounts = (devices) => Object.fromEntries(FILTERS.map((f) => [f, devices.filter((d) => matches(d, f)).length]));

// Waiting PCs first (they need someone), then by name.
export const sortDevices = (list) => [...list].sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'pending' ? -1 : 1));

// The mark, word and colour of a PC's row. `conn` is the app's attempt to connect to it, if any.
export function deviceStatus(device, conn) {
  if (device.status === 'pending') return { mark: 'wait', word: 'waiting', tone: 'live' };
  if (conn?.phase === 'connecting') return { mark: 'wait', word: 'connecting', tone: 'live' };
  if (conn?.phase === 'awaiting') return { mark: 'wait', word: 'asking', tone: 'live' };
  if (conn?.phase === 'live') return { mark: 'live', word: 'connected', tone: 'live' };
  return device.online ? { mark: 'on', word: 'online', tone: 'on' } : { mark: 'off', word: 'offline', tone: '' };
}
