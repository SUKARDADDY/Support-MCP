// A stand-in for the `cloudflare:workers` module, which exists only inside
// workerd. @cloudflare/workers-oauth-provider imports `WorkerEntrypoint` from
// it. The relay never extends it (it uses the library's authorization-server
// role from its own router), so an empty base class is enough.
export class WorkerEntrypoint {}

// The library reads this global to decide whether it may fetch Client ID
// Metadata Documents. wrangler.toml sets the compatibility flag in production,
// so the tests say the same.
globalThis.Cloudflare ??= { compatibilityFlags: { global_fetch_strictly_public: true } };
