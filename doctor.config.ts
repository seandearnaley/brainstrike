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
 *   docs/react-doctor-migration-2026-06-15.md and the REACT DOCTOR section in AGENTS.md.
 *
 * Telemetry: disabled (local-first / privacy). `noScore`/`share` cover local runs;
 * CI additionally sets REACT_DOCTOR_NO_TELEMETRY=1 (the marketplace Action has no flag).
 *
 * DO NOT add `ignore.files` (verified against react-doctor 0.5.5):
 *   Setting a non-empty `ignore.files` flips the lint pass from its default file
 *   discovery to an explicit include-list (`resolveLintIncludePaths` →
 *   `shouldIncludeExplicitLintPath`), which silently drops ~half the monorepo's real
 *   source from linting (e.g. packages/hooks went 34 → 0 findings). The patterns
 *   themselves are innocent — the mere presence of the key changes discovery. Build
 *   artifacts are gitignored (so git-based file listing never sees them) and test-file
 *   noise is already handled natively (`shouldAutoSuppress` drops `test-noise`-tagged
 *   rules in non-production files). To suppress a specific finding, use `ignore.overrides`
 *   (per file + rule) or `rules` (per rule) — never `ignore.files`.
 *
 * CLI flags override these values. CI runs `--scope changed --blocking error` via the
 * Action so only NEWLY introduced issues fail a PR; pre-existing debt stays advisory
 * while we burn it down in stacked PRs.
 */
export default {
  lint: true,
  deadCode: true,

  // No data leaves the machine.
  noScore: true,
  share: false,

  // Local default; CI overrides scope/blocking via the Action inputs.
  blocking: 'error' as const,

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

  ignore: {
    // Per-file + rule suppressions (narrower than the top-level `rules`/`categories`,
    // and NOT the forbidden top-level `ignore.files`, which would flip lint to an
    // include-list — see the header).
    overrides: [
      {
        // The thread cumulative-usage meter HYDRATES from the PGlite-backed thread
        // repository (an async DB read), so the resolved value cannot be derived
        // during render — it legitimately needs a useEffect that setStates from the
        // resolved promise (re-running on thread switch + after each new durable
        // usage write). `no-adjust-state-on-prop-change` targets SYNCHRONOUS
        // prop→state derivation (its own react.dev reference explicitly excludes
        // data fetching); this is the documented false-positive class. Same async-
        // load-in-effect shape biome accepts in use-roots-reconciliation.ts.
        files: ['**/assistant-ui-panel-wrapper.tsx'],
        rules: ['react-doctor/no-adjust-state-on-prop-change'],
      },
    ],
  },
};
