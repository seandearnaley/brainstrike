# Workspace-src alias guard — evidence

Supports `docs/agents/ci-quality.md` § "Workspace-src alias guard" (#1066/#1207,
Series B3/B4, BST-1009, BST-1720, BST-1773). Read this before changing the
shared alias registry, the `topo` transit node or any task-input exclusion, a
per-package build edge, the native-addon test lanes, or the desktop Electron
test harness. The contract holds the rules; this file is the record of why.

Corrected at extraction (verified against the repo): the desktop
`test:integration`/`test:coverage` build edges now also include
`@brainstrike/assistant-service#build`, and the `logging`/`utils` own-`build`
edge covers `test:coverage` as well as `test`. `@brainstrike/windows-job-native`
carries the same uncached build/test/coverage edges as `secure-fs-native`.
The per-package `turbo.json` files are the source of truth for the edge list.

`scripts/verify-workspace-src-aliases.mjs` (guard test:
`scripts/__tests__/verify-workspace-src-aliases.test.mjs`, run in the Static job
via `pnpm test:scripts`) prevents the #1066/#1207 regression class: a package
test lane importing another `@brainstrike/*` package at RUNTIME while its vitest
config declares NO workspace-src aliasing resolves that dep from BUILT `dist`
(via package `exports`) — stale/broken dist then silently passes.

The shared registry `@brainstrike/test-utils/workspace-src-aliases`
(`workspaceSrcAliases(packagesDir)`, a committed plain `.mjs` — no build step)
derives EXACT aliases from each package's own `exports` map: regex-exact package
root + each exported code subpath -> validated `src` file (missing source
throws). Asset exports (css/json/icons), src-pointing exports, and prebuilt
`*.worker` bundles get no alias; unexported subpaths are NOT captured (they fail
loudly under node resolution); a same-name wildcard export (preferences `./*`)
gets a validated narrow prefix. Package vitest configs spread it (config-local
mocks/dedicated helpers go BEFORE the spread — vitest `resolve.alias` is
first-match). `@brainstrike/agent` is excluded (Mastra/Node deps): consumers use
`createAgentBrowserSafeAliasEntries`. `@brainstrike/workers` has no `src/` dir:
consumers alias its subpaths explicitly. Prebuilt `*.worker` exports are also
skipped by the shared registry. When a test graph imports one as executable
source, it needs a narrow config-local override: web Vitest maps
`@brainstrike/embedding-worker/worker` to `src/embedding.worker.ts` before the
shared spread, and its integration config inherits that base alias verbatim.

The guard EXECUTES each discovered vitest config (base + integration + mutation +
models, and each inline project). Vitest 5 inline projects inherit root aliases
unless `extends: false`; string `extends` selects a separate config. The guard
uses Vite `mergeConfig` to preserve actual object/array alias precedence. Discovery is the `vitest.*config*.*` filename convention made
a CHECKED invariant: every vitest `--config`/`-c` reference in package scripts
and every stryker `configFile:` must be in the discovered set, else the guard
throws. Per config/project it closes the runtime `@brainstrike/*` specifier set
to a FIXPOINT over the src-resolved graph (a specifier that resolves into
another workspace package's source pulls in that package's non-test specifiers
— so transitive chains like embeddings → embedding-worker(src) → worker-runtime
are checked), then simulates vitest's first-match alias resolution: the winning
entry must point at an existing non-dist source path, and an unaliased
specifier must not resolve to `dist` via the dep's `exports` map. So dist-pin
overrides, imported-but-unspread registries, per-dependency gaps, bare mutation
configs, and transitive src-graph gaps all FAIL. The guard loads configs through
Vite's `loadConfigFromFile`, so app configs with Vite-supported extensionless
imports are inspected under the same loader semantics as their test lanes.
Legitimate built-artifact consumers go in `WORKSPACE_SRC_ALIAS_ALLOWLIST` with
a reason string (NO silent fallback). This was the R3 enabler for dropping
`test.dependsOn: ["^build"]` —
DONE in Series B4: `test`/`test:integration`/`test:coverage` now
`dependsOn: ["topo"]`, a synthetic no-op **transit node** (`topo`,
`dependsOn: ["^topo"]`) that carries the upstream SOURCE-hash cascade WITHOUT
building anything, so a `packages/types` edit no longer rebuilds ~39 packages
before a test runs. Plain deletion of the edge would be a stale-green landmine
(tests import upstream source, so a cached dependent must still re-hash when an
upstream's source changes); the transit node REPLACES the edge instead of
removing it. `topo` hashes full default inputs except the guarded BST-1773
pilot in `@brainstrike/types`: its `topo` and `build` exclude only executable
`**/*.test.*` and `**/*.spec.*` files, matching its TypeScript build exclusions.
Owner `test`/`test:coverage` inputs remain complete. The explicit lost-file reporter
input remains a hash carrier. Never remove transit edges to narrow affected work.

`lint:private-test-input-locality` runs in local and CI lint. It rejects imports
and filesystem reads into the Types private-test boundary, including static,
dynamic, constant-bound URL and partially static paths. Directory inventories and
existence checks are reads too: filesystem method aliases and alternative path
bindings must retain the same boundary checks. Only private Types specs
may consume peer private specs. Shared helpers must live outside excluded paths;
do not blanket-exclude `__tests__` directories. Extend this bounded policy and its
negative controls before introducing another path-construction convention or pilot.
This JS/TS reader guard does not model declarative JSON/YAML or tool-config globs.
Do not add cross-package config globs over private Types specs; move shared
fixtures outside the private boundary or explicitly model and test their task
inputs before introducing such a consumer.
`private-test-input-locality.test.mjs` uses the pinned Turbo binary to verify both
hashes and affected selection, including a deliberately unsafe exclusion.

File-node factories belong to `@brainstrike/file-tree-test-fixtures`, consumed by
file-explorer, file-explorer-hooks, file-explorer-ui, utils and workers. Generic
`@brainstrike/test-utils` must not depend on `@brainstrike/types`. The domain
fixture package may consume generic test setup; that edge is intentionally one-way.

The chunk-cycle guard is an explicit input of web/desktop `build` and desktop
`build:renderer`, not a global input. Coverage enforcement runs directly after
coverage collection, outside Turbo caching, so its script is not a global input.
`ci-guard-input-locality.test.mjs` proves these boundaries with actual Turbo hashes
and affected selection, with negative controls for missing build invalidation.
It discovers direct guard consumers from workspace scripts, rejects package-level
coverage-enforcement scripts, pins the absence of root build-input overrides, and
requires cached coverage tasks to restore `coverage/**` before enforcement.

BST-1773 measurements against `7bc7f079` used isolated Git fixtures and pinned
Turbo `test test:integration --dry=json`, comparing executable task selection and
hashes. Types source edits fell from 61 to 49 tasks; private Types test edits from
61 to 1; domain-factory edits from 60 to 43. Generic setup edits changed 60 before
and 61 after (the new fixture suite is an intentional consumer). Each guard script
previously invalidated 65 test tasks and now invalidates none; chunk guard edits
still invalidate all three consuming app build tasks. Types manifest downstream
reach fell from 47 to 37. These are invalidation counts, not measured CI durations.

Explicit build edges survive in per-package `turbo.json` where a test genuinely
consumes a built artifact:
`@brainstrike/desktop#test:integration`/`#test:coverage` need
`@brainstrike/agent#build`, `@brainstrike/assistant-data#build` and (added
later) `@brainstrike/assistant-service#build` for the native
delegated-decision restart verifier (BST-1720): child Node processes resolve
public exports without Vitest aliases.
These exact dependencies build the agent's DB/contract closure and the startup
reaper's public assistant-data export. The resolved graph is guarded by `turbo-global-configuration.test.mjs`; no inline
build or repository-wide `^build` edge is introduced.
`@brainstrike/logging#test` needs its own `build` (logger-dist-singleton test
imports logging's `dist` by file URL); `@brainstrike/utils#test` needs its own
`build` (typescript-build-contract test inspects emitted files);
`@brainstrike/db#test`/`#test:coverage`
need `@brainstrike/utils#build` (migration-runner-types test's nested
`ts.createProgram` resolves utils types from `dist` — vitest aliases can't
intercept tsc); `@brainstrike/secure-fs-native#test`/`#test:coverage` need
their own `build` (the tests load the compiled `.node` addon — and the edge
must NOT be replaced by an inline `pnpm build &&` in the test script: that
shape raced turbo's concurrently-scheduled `build` task as two simultaneous
`node-gyp rebuild`s in one directory ("make: No targets specified and no
makefile found"; reproduced 2026-07-19). Guarded by
`scripts/__tests__/native-addon-build-uncached-contract.test.mjs`; the
`native-windows` job bypasses turbo and therefore builds explicitly before
testing).

BOTH native lanes are also `cache: false`, not just `build`. `build` being
uncached guarantees a FRESH binary; it does not guarantee anything LOADED it,
so a cacheable `test`/`test:coverage` would replay a logged green without ever
dlopening the addon — the exact hazard the package's `test` task documents.
`test:coverage` is the easy one to miss because the ROOT `test:coverage` task
caches (unlike root `test:integration`), and `nightly-coverage.yml` runs
`turbo run test:coverage`. The guard above resolves EFFECTIVE cacheability
(package override → root task → turbo default) for every turbo-scheduled test
lane of a native package.

Because these lanes no longer build inline, invoking them OUTSIDE turbo and
without a prior build (`pnpm --filter @brainstrike/secure-fs-native test`, or a
bare `pnpm test:fast` / `test:coverage:base`, which use recursive `pnpm -r`
rather than turbo) finds no addon. This matches `@brainstrike/logging` and
`@brainstrike/utils`, whose built-artifact tests fail the same way without a
prior build, and the `check.mjs`
gate is safe because it runs `build` before the turbo test lanes sequentially
(BST-1009 replaced its `test:fast`/`test:coverage:split` steps with the same
`turbo run test` / `turbo run test:integration` invocations CI uses, so the
addon arrives through turbo's own `#build` edge either way). A preflight
(`test/ensure-addon.cjs`) turns that case into an actionable message naming the
build command instead of `bindings`' generic "Could not locate the bindings file".
It deliberately CHECKS rather than builds: auto-building on a miss would silently
reuse a stale addon after a C++ edit, and it would reintroduce a second build
declaration. The apps needed NO build edges in the original B4 clean-state proof run
exposed gaps in their hand-maintained vitest alias maps (specifiers falling
through `exports` to dist — invisible while `^build` guaranteed dist existed),
closed by aliasing instead: apps/web gained the missing root aliases
(assistant-contract, chunking-worker, context-actions, file-system,
indexing-contract, storage); apps/desktop now spreads this same
`workspaceSrcAliases` registry (array-form alias, locals first) plus an
agent-root→src alias mirroring web (the registry deliberately excludes agent).
The guard checks both `packages/*` and `apps/*` (the default entrypoint passes
`appsRoot`), so app alias gaps fail the same source-resolution contract instead
of depending on a clean-state resolution crash. Desktop's agent-client-loader
tests pin the loader's FALLBACK_PROVIDERS against the agent SOURCE via
`vi.importActual` — no hand-maintained duplicate (raw require in the loader
bypasses vitest aliases and needs dist, absent by default post-B4, so CI
exercises the FALLBACK path). FALLBACK_PROVIDERS is therefore an explicit tuple
in registry DECLARATION order with compile-time exhaustiveness pins against the
FALLBACK_ENV_KEYS Record (PR #2513 review); do NOT derive it from `Object.keys`
of the Biome-sorted Record — that changes the order only in the dist-absent
state CI runs in. See the Series B turbo-monorepo architecture review.

Desktop main-process unit tests share observable Electron controls in
`apps/desktop/src/__tests__/helpers/electron-main-test-harness.ts`. The harness
layers `vi.fn()`-backed IPC registration and WebContents state over the inert
default surface owned by `apps/desktop/src/__tests__/electron-test-stub.mts`;
new Electron API defaults belong in the stub so the alias and global mock do
not drift. Tests needing those observable controls import the harness instead
of redeclaring `vi.mock('electron')` or patching missing cleanup methods.
Narrow tests may still replace Electron deliberately when they exercise a
different surface, but IPC-focused tests reset the shared harness in
`beforeEach` so owned mock implementations, handler/listener registrations,
and WebContents never leak across cases. The paired harness test pins surface
parity, duplicate registration failure, multi-listener cleanup, and reset
semantics.
