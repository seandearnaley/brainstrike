/**
 * React Doctor configuration.
 *
 * React Doctor runs TWO passes:
 *   1. lint     — ~250 React/JS rules (Security, Bugs, Performance, Accessibility,
 *                 Maintainability) via the bundled oxlint + react-hooks engines.
 *   2. deadCode — the `deslop` engine (unused files / exports / types / circular deps,
 *                 and — disabled below — unused dependencies).
 *
 * Relationship to knip.jsonc:
 *   `deslop` is NOT knip. It does NOT honor knip's `ignoreDependencies` and has no
 *   per-dependency allowlist. Our dependency false-positives (CSS @imports, lazy
 *   prebundles, dynamic requires, peer deps) are curated in knip.jsonc and remain owned
 *   by `pnpm knip`. We therefore DISABLE deslop's two dependency rules here. See
 *   docs/react-doctor-migration-2026-06-15.md and the REACT DOCTOR section in docs/agents/ci-quality.md.
 *
 * Telemetry: disabled (local-first / privacy). `noScore`/`share` cover local runs;
 * CI additionally sets REACT_DOCTOR_NO_TELEMETRY=1 (the marketplace Action has no flag).
 *
 * Broad file ignores are intentionally absent. React Doctor 0.9.3 fixed the old
 * 0.5.5/0.7.1 coverage defect: `resolveLintIncludePaths` now enumerates every
 * supported source and only then filters ignored paths. Build artifacts are
 * already gitignored, and test-noise-tagged rules auto-suppress in non-production
 * files, so this repo has no reason to hide whole source files. Use the narrower
 * `ignore.overrides` (file + rule) or `rules` (per rule) for a proved exception.
 *
 * CLI flags override these values. CI runs `--scope changed --blocking error` via the
 * Action so only NEWLY introduced issues fail a PR; pre-existing debt stays advisory
 * while we burn it down in stacked PRs.
 */
export default {
  // Shared default; the root script and CI Action set scope, and CI also sets blocking.
  blocking: 'error' as const,

  categories: {
    // Accessibility is already enforced by this repo's biome a11y rules, and the team
    // documents intentional exceptions with `biome-ignore` comments. react-doctor does
    // NOT read biome-ignore, so it re-flags every documented exception plus custom ARIA
    // widgets (SVG gauges, draggable range bands, listbox/combobox) where the suggested
    // native tag is not a drop-in. An audit of all 28 a11y findings found 27
    // false-positive/intentional and 1 genuine gap (fixed: vector-status Reinit label).
    // Keeping this on duplicates biome and floods the gate with noise.
    // biome-ignore lint/style/useNamingConvention: react-doctor category keys are PascalCase
    Accessibility: 'off' as const,
    // Security: an audit of all 6 real-source findings found 0 genuine issues — a test
    // mock `new Function`, a guarded pgvector `sql.raw` (validated via
    // validateEmbeddingVector), a non-crypto diagnostic signature, a localStorage
    // sentinel mistaken for a secret, and pnpm-hardening nags. Secret detection is
    // already covered by the lefthook `secrets-scan`. pnpm supply-chain hardening
    // (minimumReleaseAge / trustPolicy) is tracked separately as an infra decision.
    // biome-ignore lint/style/useNamingConvention: react-doctor category keys are PascalCase
    Security: 'off' as const,
  },
  deadCode: true,

  ignore: {
    // `overrides` is the narrow, documented suppression tool (per file + rule).
    // Keep whole-file ignores absent unless a future case proves they are the
    // correct scope; the current repository needs none. Control-verified when
    // this block was added: every package's finding count was unchanged except
    // @brainstrike/db, which dropped by exactly the one suppressed finding.
    overrides: [
      {
        // `clearViaPGlite` / `purgeTablesTx` issue their full reset-table-
        // registry sweep (27 relations, BST-992) on ONE PGlite connection
        // inside ONE transaction. `Promise.all` would race statements
        // on a single connection, and once any statement fails the transaction
        // is aborted, so the "parallel" remainder would only pile up `25P02
        // current transaction is aborted` errors. Sequential is required for
        // correctness, not an oversight — the rationale is also inline at the
        // call site. See the FACTORY RESET CONTRACT in
        // docs/agents/platform-contracts.md.
        // Package-RELATIVE, not repo-relative: globs are matched against the
        // scanned directory, which is each workspace package. A repo-relative
        // 'packages/db/src/db-provider.tsx' silently matches nothing (verified —
        // every finding count stayed identical). db-provider.tsx is unique in
        // the repo, so this cannot over-match another package.
        files: ['src/db-provider.tsx'],
        rules: ['react-doctor/async-parallel'],
      },
    ],
  },

  lint: true,

  // No data leaves the machine.
  noScore: true,

  rules: {
    // Owned by knip (which has the curated ignoreDependencies allowlist). deslop cannot
    // express per-dependency ignores, so leaving these on produces ~59 false positives.
    'deslop/unused-dependency': 'off' as const,
    'deslop/unused-dev-dependency': 'off' as const,
    // Mirror knip.jsonc's `rules.exports: "off"` — the project deliberately disabled
    // unused-export checking due to false positives. deslop's version is strictly more
    // FP-prone: it scans each package in isolation WITHOUT entry-point config, so every
    // cross-package public-API export looks "unused", and it flagged knip-ignored
    // scripts/. Left active: deslop's higher-signal unused-file + circular-dependency.
    'deslop/unused-export': 'off' as const,
    'deslop/unused-type': 'off' as const,
    // Manual memoization is INTENTIONAL in this repo. We run the React Compiler, but
    // deliberately keep manual useMemo/useCallback/React.memo where it guards non-React
    // expensive work, external-store identity, or referential stability for consumers
    // outside the compiled tree. This rule fired 1211x (54% of the original 2258-finding
    // backlog) demanding their removal — a large, opinionated, high-blast-radius refactor
    // of working code. Disabled per team decision. (react-hooks-js/preserve-manual-
    // memoization stays ON — it protects memo the compiler still needs.)
    'react-doctor/react-compiler-no-manual-memoization': 'off' as const,
  },
  share: false,
};
