// The only way a return path ("next") becomes a redirect target or a link.
export const DEFAULT_NEXT = '/account';

const BASE = 'https://placeholder.invalid';
const CONTROL = /[\u0000- \u007f-\u009f]/;

// A path on this site that is safe to put in a Location header or an href:
// one slash at the start (never `//` or `/\`), no backslash, no control
// character, nothing that decodes to a slash or backslash in the path part.
// The check runs on the input and again on what the URL parser makes of it,
// because the parser folds dot segments: `/..//evil.example` becomes
// `//evil.example`. Anything else gives DEFAULT_NEXT. Applying it twice gives
// the same answer, so every place that emits a path applies it again.
function plainPath(p, max) {
  return typeof p === 'string' && p.length <= max && p.startsWith('/') && !p.startsWith('//')
    && !p.includes('\\') && !CONTROL.test(p);
}

// `max` is 300 for a path a person sends us. Our own redirects carry such a path
// inside a query string, percent-encoded once or twice, so they allow more.
export function safeNext(value, max = 300) {
  if (!plainPath(value, max)) return DEFAULT_NEXT;
  let u;
  try { u = new URL(value, BASE); } catch (_) { return DEFAULT_NEXT; }
  if (u.origin !== BASE) return DEFAULT_NEXT;
  // Judge the path before the query: an encoded slash in the query is ordinary.
  if (/%(2f|5c)/i.test(u.pathname)) return DEFAULT_NEXT;
  const out = u.pathname + u.search;
  return plainPath(out, max) ? out : DEFAULT_NEXT;
}
