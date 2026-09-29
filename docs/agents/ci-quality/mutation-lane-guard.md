# Mutation-lane contract guard — evidence

Supports `docs/agents/ci-quality.md` § "Mutation-lane contract guard"
(BST-1331, BST-1287, #2475). Read this before widening the reporter roster,
changing how a `mutation` script invokes Stryker, or changing guard discovery.
The contract holds the rules; this file is the record of why each invariant exists.

`scripts/verify-stryker-mutation-contracts.mjs` (guard test:
`scripts/__tests__/verify-stryker-mutation-contracts.test.mjs`, run in the
Static job via `pnpm test:scripts`) keeps the advisory Stryker lane from rotting
silently — the lane is on-demand, so a drifted runner invocation or broken
config stays invisible until someone runs `pnpm mutation` (the #2475 rot class;
BST-1287 shipped the Stryker 10 upgrade this guard builds on).

Discovery is workspace-driven: the globs under `packages:` in
`pnpm-workspace.yaml` are expanded from the repo root (not just direct
`packages/*` children), every resulting directory is scanned for a `mutation`
script, an unparseable `package.json` under a scanned root throws instead of
being skipped (it could hide a mutation script), and an empty discovery set
throws rather than reporting green. The parser deliberately reads only a tiny
YAML subset (top-level scalar globs); anything else fails loudly.

Five invariants per contract:

1. **Local-bin invocation, allowlisted.** The `mutation` script must match
   `^stryker\s+run\b` (arguments allowed) AND declare `@stryker-mutator/core`
   in its dependencies — that declaration is what puts the `stryker` bin in
   the package's own `node_modules/.bin` under pnpm's isolated layout.
   Anything else violates: `npx @stryker-mutator/core run` ignores the catalog
   pin via registry resolution (the original BST-1287 gap), `npx stryker run`
   keeps the registry in the path, and neutered commands (`echo skipped`)
   kill the lane invisibly. This is deliberately an allowlist, not a denylist.
2. **Unambiguous config by Stryker's own precedence.** Candidates are probed
   in exactly @stryker-mutator/core 10's `SUPPORTED_CONFIG_FILE_NAMES` order
   (`stryker.conf.json → stryker.conf.js → .mjs → .cjs → stryker.config.* →
   dot variants`), and only the first existing file is evaluated — the same
   file a real mutation run loads. TWO OR MORE candidates present is itself a
   violation: a stale valid `.cjs` beside a broken `.js` replacement would
   otherwise let the guard validate a file Stryker never reads.
3. **Loadability under repo semantics.** The selected config is loaded exactly
   as Stryker loads it (`.json` parsed; everything else through `import()`,
   which gives CJS interop for `.cjs`; packages are `"type": "module"`, so
   `.js` configs must be ESM — `file-system` deliberately ships `.cjs`). A
   load failure is a violation carrying the underlying error.
4. **Agreed reporter roster.** Values in `reporters` are STRYKER reporter
   names; the supported set (`clear-text`, `html`, `json`, `progress`) is a
   deliberate house roster, NOT a Vitest capability claim (Stryker built-ins
   like `dots` are legal upstream — widening is a reviewed decision). A
   NON-array `reporters` value is itself a violation, never coerced into
   "nothing to validate" (NO SILENT FALLBACKS). Leaving `reporters` absent is
   allowed: Stryker's defaults are inside the set. History: Vitest 4 removed
   `basic` from @stryker-mutator/vitest-runner's supported reporters, which is
   how the #2475 lane rotted — but that reporter name lives inside the vitest
   runner plugin, so this check bounds the roster; it cannot itself see it.
5. **Mutation Vitest wiring survives refactors.** `vitest.configFile` must
   basename to `vitest.mutation.config.ts` and the referenced file must exist.

Entrypoints follow the BST-836 shape: `main({ repoRoot })` anchors discovery,
`directory` is honored as the same anchor so the generic entrypoint control
harness drives it uniformly, and direct execution checks the real repo.
