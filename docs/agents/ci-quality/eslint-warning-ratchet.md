# ESLint warning ratchet and the Fast Refresh boundary rule — evidence

Supports `docs/agents/ci-quality.md` § "REACT DOCTOR (LINT)" — the rules that
`react-refresh/only-export-components` (ESLint) owns the Fast Refresh
module-boundary contract, that `eslint-warning-baseline.json` is a per-rule
two-way ratchet, and that verifier entrypoint proofs run against a bounded
`--repo-root` (BST-1220). Read this before swapping in Biome's
`useComponentExportOnlyModules`, returning to a scalar `--max-warnings`, or
making the entrypoint test re-run full-tree audits.

- **The Fast Refresh module-boundary contract is NOT react-doctor's — it is
  `react-refresh/only-export-components` in `eslint.config.js`** (BST-1220, #2372, plugin
  `eslint-plugin-react-refresh`), riding the same `--max-warnings` ratchet as the
  compiler diagnostics. It landed at 155 warnings across 77 files; burn it down and lower
  its baseline entry, exactly as for the compiler wave.
  **That ratchet is now PER RULE.** `eslint-warning-baseline.json` holds one budget per
  rule id and `scripts/verify-eslint-warning-baselines.mjs` enforces it as `lint:eslint`.
  A rule OVER its entry fails; a rule UNDER its entry also fails until the entry is
  lowered, so every burn-down is banked instead of leaving headroom behind; a rule with
  findings and no entry fails; error-severity findings never get a budget. This replaced a
  single `--max-warnings=N` scalar, which could not tell the two warning families apart —
  burning Fast Refresh warnings silently granted the same headroom to compiler
  diagnostics. The scalar had already failed that way: #2372 found 186 actual warnings
  under an unchanged 194 ceiling. Re-baseline with
  `pnpm run lint:eslint --write-baseline`, and read the diff — an unexplained drop is a
  rule going dark, not a win. Biome's `useComponentExportOnlyModules`
  was evaluated and rejected for this job despite already being installed and already
  blocking: measured against this repo it also flags unexported components (63 sites —
  not a defect, since `@vitejs/plugin-react`'s `validateRefreshBoundaryAndEnqueueUpdate`
  walks `moduleExports` only, so a private component never breaks the boundary) and
  misreads `export default <Component>` aliases (29 false positives, e.g.
  `logging-settings.tsx`, whose only exports are one component named and defaulted).
  The eslint plugin matches the Vite runtime semantics; do not swap in Biome's rule
  without re-measuring both.

  The required Static job owns the full-tree ESLint verdict through `lint:ci` ->
  `lint:eslint`. `scripts/__tests__/verify-script-entrypoints.test.mjs` separately proves
  that executable verifier wiring can run and fail; it must not repeat full-tree audits merely
  to observe output. The four measured hotspots — ESLint warning baselines, workspace source
  aliases, private test input locality, and source cycles — therefore support an explicit
  `--repo-root <path>` control seam. Their full-tree verdicts remain in their owning lint
  commands or paired real-tree tests: `eslint-warning-baseline-contract.test.mjs`,
  `verify-workspace-src-aliases.test.mjs`, `private-test-input-locality.test.mjs`, and
  `verify-no-source-cycles.test.mjs`, respectively. The bounded-control map names those owners and
  fails if an owner test disappears. The entrypoint test launches each of those four bounded real
  child processes against a temporary invalid root and requires all three signals: output, a nonzero exit, and a
  fixture-specific failure path. Its executable negative controls cover a no-op `main`, an
  incorrect direct-execution predicate, an ignored fixture root, and a lost nonzero exit
  status. Each default command remains the full repository audit, including ESLint's
  `--write-baseline` mode. On the 2026-09-18 main checkout, two local entrypoint-suite
  baselines took 26.39s and 26.54s; the bounded suite took 3.11s. The four duplicate scans
  accounted for 24.08s in the per-verifier profile. This is verifier-proof cost, not a
  guaranteed reduction in the required check's final elapsed time.
