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
  },
};
