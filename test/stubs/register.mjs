// Preloaded by `npm test` (node --import ./test/stubs/register.mjs --test).
// Installs the resolve hook that maps `cloudflare:workers`, which only workerd
// can load, to a stub, so the OAuth library loads under Node.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
