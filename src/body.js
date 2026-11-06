// Reads a request or response body as text without trusting its size. The
// declared length is checked first, then the stream is read chunk by chunk and
// cancelled the moment it passes `max` bytes, so a body with no Content-Length
// (or a lying one) is never held whole in memory. Returns the text, or null when
// the body is too large.
export async function readTextCapped(message, max) {
  const declared = message.headers.get('content-length');
  if (declared !== null && Number(declared) > max) return null;
  if (!message.body) return '';
  const reader = message.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(all);
}
