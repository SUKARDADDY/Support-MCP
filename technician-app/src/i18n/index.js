// Every string the person reads is in en.json, so the app can be translated by adding a file.
import en from './en.json';

let table = en;

// Replaces {name} with vars.name. A missing key shows the key, so a gap is easy to spot.
export function t(key, vars = {}) {
  const text = table[key];
  if (text === undefined) return key;
  return text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined ? `{${name}}` : String(vars[name])));
}

// A count: uses key_one for 1 and key_other for the rest, with {count} filled in.
export function tn(key, count, vars = {}) {
  return t(`${key}_${count === 1 ? 'one' : 'other'}`, { count, ...vars });
}

export function hasKey(key) {
  return Object.hasOwn(table, key);
}

export const keys = () => Object.keys(table);
