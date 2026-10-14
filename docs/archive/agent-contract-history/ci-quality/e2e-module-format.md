# E2E module format — evidence

Supports `docs/agents/ci-quality.md` § "E2E module-format contract" (BST-1217,
BST-1226, BST-1014). Read this when Playwright collects zero tests, a named
import from a workspace library fails to link in a spec, or before changing
either `apps/*/e2e/package.json`, a `playwright.config.mts`, or an import that
leaves an e2e root.

`scripts/e2e-module-format-contract.mjs` (paired test:
`scripts/__tests__/e2e-module-format-contract.test.mjs`, run in the Static job
via `pnpm test:scripts`) holds the module format of both Playwright graphs.

Playwright picks a format per file from the nearest `package.json` `type`
(`transform/esmLoader.js`: `isRequire ? 'commonjs' : fileIsModule(filename) ?
'module' : 'commonjs'`). `apps/desktop` and `apps/web` are deliberately
CommonJS — Electron main, electron-builder and the vite configs depend on it —
so once BST-1014 moved the shared libraries to ESM-only `tsc -b` emit, every
spec was CommonJS and every ESM-only library it reached was force-transpiled.
`import.meta` cannot be represented in CommonJS (this took desktop spec
collection to *0 tests in 0 files* for over a month), and `export *` becomes a
runtime getter loop that cjs-module-lexer cannot see through, so static named
imports of re-exported bindings fail to link. A dynamic `import()` avoids that
specific named-export linking failure, which is what made it look selective;
it does not make `import.meta` or a CommonJS `require()` of an ESM-only package
safe.

Three assertions, over every `apps/*/e2e` directory that holds specs:

1. **The graph is ESM.** The nearest manifest must declare `"type": "module"` —
   that is `apps/desktop/e2e/package.json` and `apps/web/e2e/package.json`,
   neither of which is a workspace member (`pnpm-workspace.yaml` globs
   `apps/*`, not `apps/*/e2e`).
2. **The Playwright config shares that format.** Both configs are
   `playwright.config.mts`, ESM by extension regardless of the app manifest. A
   CommonJS config that imports a workspace library pulls it in through
   `require`, forcing a CommonJS transform that then collides with any spec's
   static import of the same library. This was live: web's config imported
   `parsePositiveIntegerConfig` from `@brainstrike/platform-utils`, and removing
   only that one import made the whole web suite collect again.
3. **Runtime escaping imports stay CommonJS-safe.** A static runtime relative
   import that leaves an e2e root lands under the app's CommonJS manifest, so it
   is transpiled inside an otherwise-ESM graph. The contract walks that target's
   complete static relative-import graph, with cycle protection, stopping when
   it reaches an ESM manifest or re-enters an e2e root. Every CommonJS node must
   contain no bare runtime dependency, no `export *`, and no `import.meta`.
   Statement-level type-only imports do not create a runtime crossing and are
   ignored; inline type modifiers are conservatively inspected. Today the only
   crossing is desktop's `../../src/desktop-renderer-config`, an import-free
   resolver leaf; web's apparent `web-e2e-test-hooks` edges are type-only.

   This third assertion closes the Linux failure BST-1226 exposed after the
   initial BST-1217 repair: `desktop-renderer-url.ts` was lexer-safe itself but
   statically imported ESM-only `@brainstrike/logging`, so Node 24.18 tried to
   require `packages/logging/dist/index.js` from the CommonJS-transpiled target
   and Playwright collected zero tests. Main keeps the logging adapter in
   `desktop-renderer-url.ts`; E2E imports only the shared, import-free resolver.

The contract module is a **library** — importing it runs nothing. The test is
the gate, and every real-tree assertion is paired with a synthetic control
proving the predicate reports the defect when present. Placement in the Static
job is deliberate: the original failure was not "the lane broke" but "the lane
broke and nobody noticed for a week", because `desktop-e2e.yml` is
schedule-only. Deleting either manifest fails this test in the PR-required job.
