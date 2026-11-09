// The first line of the instructions of the tasks this app started, so a title the relay
// cut at 100 characters can be shown whole. Kept for the last 50 tasks in this app's own
// storage, which also holds the open tabs.
const KEY = 'support.task_titles';
const KEPT = 50;

// What the relay takes as a task's title before it cuts it: the first line.
export const firstLine = (text) => String(text ?? '').split('\n')[0].trim();

export function loadTitles() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

// The map with one more task in it; the oldest are dropped past 50. Saved as it is made.
export function withTitle(map, taskId, instructions) {
  const line = firstLine(instructions);
  if (!taskId || !line) return map;
  const next = Object.fromEntries([...Object.entries(map).filter(([id]) => id !== taskId), [taskId, line]].slice(-KEPT));
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (_) {
    // no storage: the full title lasts until the app closes
  }
  return next;
}
