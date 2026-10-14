# Desktop development dependency freshness and HMR boundary — evidence

Supports `docs/agents/ci-quality.md` § "Desktop development dependency
freshness". Read this before changing `scripts/ensure-desktop-dev-deps.mjs`,
the agent-debug preflight order, or the `fullReloadOnCompilerHotspots` plugin.
The contract holds the rules; this file is the record of why.

### Desktop development dependency freshness

`apps/desktop` invokes `scripts/ensure-desktop-dev-deps.mjs` for development,
including `dev:agent-debug`. Under root `pnpm dev`, the root pre-script already
completed that graph, so the desktop pre-script skips only when Turbo carries
the explicit preparation marker described in
`docs/agents/ci-quality.md` § "Development startup ordering".
Standalone desktop and agent-debug launches run the helper synchronously.
Agent-debug runs that preflight
to completion before loading the Windows Job Object addon, then starts the
internal `dev:runtime` script under the initialized Job. This order is
mandatory on Windows: a loaded native addon cannot be replaced by node-gyp, so
loading the Job Object first would make a cold dependency build fail with
`EPERM`. When it is not inside a marked, already-prepared graph, the helper must ask
Turbo to build the exact desktop dependency graph.
Turbo's content hashes and cache are the freshness authority; checking only
whether `dist` files exist is forbidden because branch updates can leave
tool schemas, prompts, or provider code silently pinned to an older commit.
On a warm graph this check is cache-only and does not rebuild the desktop
renderer or unrelated packages. A non-zero Turbo result remains a visible
startup failure.

The shared `fullReloadOnCompilerHotspots` Vite plugin is the development HMR
boundary for cross-package React providers and stores. A hotspot update must
first call Vite's `moduleGraph.invalidateModule` for every affected module with
one shared invalidation set, the update timestamp, and importer invalidation
enabled; only then may it broadcast `full-reload` and return `[]`. Returning an
empty module set without that explicit invalidation leaves cached importer
transforms pointing at different timestamped module identities, which can make
a context consumer fail to see its mounted provider after reload. The contract
is pinned in `packages/build-utils/src/__tests__/vite.test.ts`.
