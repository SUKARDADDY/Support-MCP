// A module resolve hook (see register.mjs). It changes one specifier and passes
// every other to Node unchanged.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return { url: new URL('./cloudflare-workers.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
