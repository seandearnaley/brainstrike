# React Compiler inventory — evidence

Supports `docs/agents/ci-quality.md` § "React Compiler bailouts are invisible —
measure them" (BST-1659, BST-1652). Read this before changing the compiler
toolchain (`@vitejs/plugin-react`, `oxc-transform-react`, `compilationMode`),
touching `scripts/react-compiler-inventory.mjs`, removing the root Babel
devDependencies, or treating an `eslint-warning-baseline.json` increase as a
regression. The contract holds the rules; this is the 2026-09-06 migration
record and the reasoning behind the instrument's refusals.

Both app bundles run the React Compiler through `oxc-transform-react` (Rust), enabled as
`react({ compiler: ReactCompilerConfig })` in `apps/web/vite.config.mts` and
`apps/desktop/vite.config.mts`. `compilationMode: 'infer'` is unchanged and is a non-goal to
change. The Babel detour (`@rolldown/plugin-babel` + `reactCompilerPreset`) is gone from both
apps; `@vitejs/plugin-react` ≥ 6.1.0 with the optional peer `oxc-transform-react` replaces it,
and the same plugin now owns the JSX transform and Fast Refresh injection.

- **oxc is not "preferred" — it is the only backend `react({ compiler })` has.** This matters
  because `babel-plugin-react-compiler` and `@rolldown/plugin-babel` stay resolvable next to
  `@vitejs/plugin-react` through workspace-root peer resolution even though both app manifests
  dropped them, so "Babel is out of the app builds" needs proof rather than absence.
  `createReactCompilerPlugin` in `@vitejs/plugin-react@6.1.1` contains a single
  `await import('oxc-transform-react')` and no Babel branch; a missing package is
  `this.error(...)`, a hard build failure, never a fallback. `reactCompilerPreset` (the Babel
  path) is only reachable if a config calls it and feeds it to `@rolldown/plugin-babel` —
  neither app does. Confirmed three ways on 2026-09-06: the plugin source above; the build's own
  `PLUGIN_TIMINGS` block naming `vite:react-compiler transform (1656 calls)` with no
  `@rolldown/plugin-babel` row; and by mutation — hiding `oxc-transform-react` from
  `node_modules` and the plugin's peer directory, with `babel-plugin-react-compiler@1.0.0` left
  in place, fails `vite build` with `React Compiler requires the optional 'oxc-transform-react'
  package`. Re-run that mutation rather than trusting a version bump.
- **Restore the `.vite` exclusion whenever `cacheDir` moves out of `node_modules`.**
  `@vitejs/plugin-react` defaults to `exclude: /\/node_modules\//`, but both apps set
  `cacheDir: <app>/.vite`, so the dep-optimizer output sits OUTSIDE `node_modules` and the
  default would let the compiler and the Fast Refresh transform run over pre-bundled dependency
  chunks in dev. Both configs pass `exclude: [/[\\/]node_modules[\\/]/, /[\\/]\.vite[\\/]/]`,
  which is what the removed `@rolldown/plugin-babel` pass carried. This is a dev-path
  correctness guard: the production bundle is byte-identical with and without it (1283 cache
  sentinels either way).
- **What else the filter swap changed, and what it did not.** The compiler's eligible extension
  set narrowed from `/\.(?:[jt]sx?|[cm][jt]s)(?:$|\?)/` (`@rolldown/plugin-babel`'s default) to
  `/\.[tj]sx?$/`, dropping `.mjs`/`.cjs`/`.mts`/`.cts`; the only first-party module of that
  shape in either app graph is a worker, so nothing was lost. `.ts` is NOT excluded — mapping
  the built bundle's `react.memo_cache_sentinel` sites back through a `--sourcemap` build lands
  on `.ts` modules (`packages/db/src/use-db.ts`, `packages/ui/src/hooks/use-copy-to-clipboard.ts`
  and peers) at roughly the inventory's own 17% `.ts` share, so there is no category-level
  `.ts` loss hiding under a net bundle-wide gain. The compiler's position in the pipeline did
  NOT change either: `@rolldown/plugin-babel` and `vite:react-compiler` are both
  `enforce: 'pre'`, and Vite orders every pre plugin ahead of the core `vite:oxc` JSX transform,
  so both passes saw real JSX rather than `_jsx(...)` calls. Do not attribute the 978 → 1130
  delta to a transform-ordering change.
- **A bailout is silent in BOTH backends, and no build flag changes that.** `infer` skips any
  function it cannot analyse and emits nothing. `oxc-transform-react` 0.148.0 returns only
  *fatal* diagnostics in `TransformResult.errors`, which stay empty for an ordinary bailout, and
  `@vitejs/plugin-react`'s `compiler.logDiagnostics` forwards exactly those same `errors` — so
  turning it on does NOT surface bailouts. Do not cite it as bailout coverage.
- **`scripts/react-compiler-inventory.mjs` is the measurement.** One command per backend:
  `node scripts/react-compiler-inventory.mjs --backend <babel|oxc> --out <file.json>`, plus
  `--diff <baseline.json> <candidate.json>`, which exits nonzero when a function that compiled
  in the baseline no longer compiles. Run the diff before any compiler-toolchain change.
  `scripts/__tests__/react-compiler-inventory.test.mjs` guards it under `pnpm test:scripts`.
- **The instrument refuses to report a false green.** An unknown `--backend` is rejected before
  the walk (it used to become one identical per-file failure, a written JSON and exit 0); an
  inventory carrying ANY analysis failure is neither written nor diffed, because a file that
  failed to parse is indistinguishable from a file with no compiled functions; and `--diff`
  rejects a baseline stamped with an older `inventoryFormat`. Regenerate baselines after
  touching the script rather than diffing against a stale one.
- **Only a function with an identity on BOTH sides is compared.** The diff keys on
  `file::name`, and the names come from the COMPILED OUTPUT, whose line numbers differ per
  backend. Three kinds of record are marked `matchable: false`: one that cannot be named, one
  sharing its name with another function in the same file, and one whose name does not appear
  in the source at all (a name the backend synthesized — two backends need not spell it the
  same way). Keying any of them surfaces one unchanged function as a regression AND a win.
  Matchability is then judged across the comparison, not per side: a key ambiguous in either
  inventory is dropped from both, because keeping the unambiguous side manufactures a win out
  of the other side's collapse. Such records are reported as an explicit "outside this
  comparison" count.
  **Dropping a key is not the same as having nothing to say about it.** Per-key compiled
  multiplicities are compared for every dropped key, and any key the candidate compiles fewer
  times than the baseline is reported as an ambiguous coverage loss and fails the command —
  otherwise a file that compiled `Row` twice and now compiles it never would print "0
  regressed" and exit 0, which is the false green this instrument exists to refuse.
  Both current inventories carry zero unmatchable records, so the numbers below are not
  softened by any of it; the rules are what keep that checkable rather than assumed.
- **The measurement is output-based, so it is identical across backends**: compile a module,
  then record every function that received a `react/compiler-runtime` cache slot. Only the
  Babel backend can also name the functions the compiler *attempted and failed*, with a reason,
  because only it exposes a per-function `logger`. That is the sole reason
  `babel-plugin-react-compiler` and `@babel/core` remain ROOT devDependencies; neither is in
  either app's build any more. An oxc report therefore carries
  `bailoutReasonsSupported: false` rather than an empty bailout list.
- **Bailouts are grouped per FUNCTION, not per error site.** The compiler logs one
  `CompileError` per failing site, so counting events inflates the total — 466 events over 258
  functions at the time of measurement.
- **Enable the JSX parser plugin only for `.tsx`/`.jsx`.** `<T>(x: T) => x` is a type-parameter
  list in `.ts` and an unterminated JSX tag in `.tsx`; parsing every file as JSX silently drops
  each `.ts` module holding a generic arrow (5 files when this was first run).

Measured on 2026-09-06 over 2177 first-party source files (`apps/web/src`,
`apps/desktop/src/renderer`, `packages/*/src`):

| | Babel 1.0.0 | oxc 0.148.0 |
| --- | --- | --- |
| functions compiled | 978 | 1130 |
| functions bailed | 258 | not reportable |
| compiler pass, single-threaded | 11.6 s | 1.02 s |

The migration diff was **0 regressions, 152 newly compiled**, with 0 records on either side
that the diff could not identify. End to end in the `apps/web` bundle,
`react.memo_cache_sentinel` sites went 1081 (Babel, measured before the migration) → 1283
(`grep -ro 'react\.memo_cache_sentinel' apps/web/dist | wc -l` on the current tree). 106
functions that Babel bailed on are still not memoized.

- **Our largest components are NOT compiled, under either backend.** The eleven largest
  first-party files each have their principal component or hook bailing:
  `threads-panel.tsx::ThreadsPanel`, `workspace-collection-sync-provider.tsx::
  WorkspaceCollectionSyncProvider`, `use-lazy-file-tree.ts::useLazyFileTree`,
  `assistant-ui-panel.tsx::LocalRuntimeChat`,
  `assistant-ui-panel-wrapper.tsx::AssistantUiPanelWrapper`, `tree-table.tsx::TreeTable` and
  peers. Their hand-written `useMemo`/`useCallback` is the only memoization they have — which
  is why `react-hooks/preserve-manual-memoization` matters and why
  `react-compiler-no-manual-memoization` stays OFF (see above). Note this is per-function, not
  per-file: `threads-panel.tsx` is 3415 lines and compiles 23 of its 25 attempted functions
  while the top-level `ThreadsPanel` bails.
- **The dominant bailout causes**, by remaining site count: destructuring defaults in an object
  pattern (`{ a = 1 }`, 63), `try`/`finally` (37), `try` without `catch` (28), refs read during
  render (24), `throw` inside `try` (14). Logical assignment (`??=`) accounts for only 4 sites,
  in 4 functions — the repo has 64 logical-assignment occurrences across 48 files, but `infer`
  never attempts the plain factory functions holding the other 60.
- **This is why `eslint-warning-baseline.json` is a floor over the *analysable* subset, not
  over the codebase.** A bailed function reports zero messages of any compiler-powered rule.
  Extracting code out of one surfaces latent findings and reads as a CI regression while being
  nothing of the sort (this cost a round-trip in BST-1652). Check the inventory before treating
  a baseline increase as a real regression, and do not adjust the baseline speculatively.
- **`??=` and `throw`-inside-`try` are not oxc-specific limitations.** Babel's React Compiler
  1.0.0 rejects both identically, so neither was a migration risk; every function failing on
  them failed before the migration too.
