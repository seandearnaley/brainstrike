// ESLint flat config: rules-of-hooks + React Compiler diagnostics.
// Base: eslint-plugin-react-hooks v7 `recommended-latest` flat preset
// (reactHooks.configs.flat['recommended-latest']), which ships the compiler
// diagnostic ruleset (purity, refs, immutability, set-state-in-effect, ...).
// The React Compiler runs in production for both apps (compilationMode
// 'infer' via babel-plugin-react-compiler in vite.config); these rules are
// its lint-time instrument.
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

const recommendedLatest = reactHooks.configs.flat['recommended-latest'];

// Compiler diagnostics run as WARNINGS for now, budgeted PER RULE in
// `eslint-warning-baseline.json` and enforced by
// `scripts/verify-eslint-warning-baselines.mjs` (the root `lint:eslint`
// script). Burning the warning wave down is downstream work (BST-575 B2-B5) —
// do not add suppression comments to source files to dodge the ratchet.
//
// The budget is exact, not a ceiling: a rule that goes OVER its entry fails,
// and a rule that goes UNDER fails too until you lower the entry. Banking every
// burn-down is what keeps freed headroom from silently becoming budget for a
// later regression. Re-baseline with `pnpm run lint:eslint --write-baseline`.
//
// This replaced a single `--max-warnings=N` scalar in #2372. That scalar could
// not distinguish rule families: burning Fast Refresh warnings silently granted
// the same headroom to compiler diagnostics. It had already failed once —
// #2372 found the count at 186 under an unchanged 194 ceiling, 8 warnings of
// invisible slack. (Prior scalar history: re-baselined 196→197 when a merge in
// flight was measured after the fact (#1790); burned 197→194 when #1764
// replaced render-phase ref writes in use-file-system-watcher with
// useEventCallback, clearing 3 react-hooks/refs.)
//
// The measure-then-merge race is still real and the per-rule map does not fix
// it: #2372 measured 161 Fast Refresh warnings, then #2368 landed mid-flight
// and split file-explorer-panel-toolbar-helpers.tsx, clearing exactly 6. The
// difference is that the map now fails loudly (rule UNDER baseline) instead of
// absorbing the delta. Re-baseline after any rebase.
const compilerDiagnosticsAsWarnings = Object.fromEntries(
  Object.keys(recommendedLatest.rules).map((rule) => [rule, 'warn'])
);

// Some in-scope files carry eslint-disable directives addressed to OTHER lint
// engines (React Doctor's eslint pass, legacy @typescript-eslint runs). ESLint
// hard-errors on directives whose rule it cannot resolve, so stub exactly
// those rule names as no-ops. Enumerated deliberately — an unknown new
// directive still fails loudly instead of being silently swallowed. If the
// REAL @typescript-eslint plugin is ever added to this config, remove its
// stub namespace first: an object-spread collision would replace the whole
// plugin (loud — every rule reports not-found — but confusing).
const noopRule = { create: () => ({}) };
const externalDirectiveStubs = {
  '@typescript-eslint': {
    rules: { 'no-var-requires': noopRule },
  },
  'react-doctor': {
    rules: {
      'async-await-in-loop': noopRule,
      'async-defer-await': noopRule,
      'no-prop-callback-in-effect': noopRule,
    },
  },
  unicorn: {
    rules: { 'prefer-top-level-await': noopRule },
  },
};

export default [
  {
    files: [
      'apps/desktop/src/**/*.{js,jsx,ts,tsx}',
      'apps/web/src/**/*.{js,jsx,ts,tsx}',
      'packages/app-shell/src/**/*.{js,jsx,ts,tsx}',
      'packages/assistant-ui/src/**/*.{js,jsx,ts,tsx}',
      'packages/db/src/**/*.{js,jsx,ts,tsx}',
      'packages/file-import/src/**/*.{js,jsx,ts,tsx}',
      'packages/notes-vault/src/**/*.{js,jsx,ts,tsx}',
      'packages/app-state/src/**/*.{js,jsx,ts,tsx}',
      'packages/settings-ui/src/**/*.{js,jsx,ts,tsx}',
      'packages/token-cache/src/**/*.{js,jsx,ts,tsx}',
      'packages/vector-management/src/**/*.{js,jsx,ts,tsx}',
      'packages/db-explorer/src/**/*.{js,jsx,ts,tsx}',
      'packages/file-explorer-hooks/src/**/*.{js,jsx,ts,tsx}',
      'packages/file-explorer-ui/src/**/*.{js,jsx,ts,tsx}',
      'packages/hooks/src/**/*.{js,jsx,ts,tsx}',
      'packages/ui/src/**/*.{js,jsx,ts,tsx}',
      'packages/workspace-search/src/**/*.{js,jsx,ts,tsx}',
    ],
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.d.ts',
      '**/__tests__/**',
      '**/*.test.*',
    ],
    languageOptions: {
      parser: tsParser,
      sourceType: 'module',
    },
    linterOptions: {
      // The stub rules above never report, so their directives would all be
      // flagged "unused"; other engines still need those comments in place.
      reportUnusedDisableDirectives: 'off',
    },
    plugins: {
      ...externalDirectiveStubs,
      ...recommendedLatest.plugins,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...compilerDiagnosticsAsWarnings,
      // Deliberate stance: dependency-array linting is intentionally absent
      // repo-wide. Biome's useExhaustiveDependencies is off for React dirs by
      // design; the React Compiler (which memoizes without dependency arrays)
      // and @jacobwolf/biome-unnecessary-effect are the compensating controls.
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/rules-of-hooks': 'error',
      // Fast Refresh module-boundary contract (BST-1220, #2372). This is the REAL
      // enforcer: react-doctor's `only-export-components` is live (warn-only, in
      // the separate oxlint-plugin-react-doctor package) but gates nothing, so the
      // many source comments citing it were describing an unenforced convention.
      // See the REACT DOCTOR section in docs/agents/ci-quality.md.
      //
      // Semantics deliberately match @vitejs/plugin-react's runtime check
      // (`validateRefreshBoundaryAndEnqueueUpdate`), which accepts an export
      // when it is component-like OR its identity is unchanged. Only EXPORTED
      // bindings matter — a private helper never breaks the boundary. Biome's
      // `useComponentExportOnlyModules` was rejected for this job — it also
      // flags unexported components (63 sites, not a defect: the runtime walks
      // `moduleExports` only) and misreads `export default <Component>` aliases
      // (29 false positives).
      //
      // `allowConstantExport` matches Vite, but it is a LITERAL-only exemption —
      // narrower than "constants". Measured against this config:
      //   exempt: string / number / template-literal initialisers, and anything
      //           PascalCase (the rule reads that as a component by convention)
      //   WARNS:  camelCase arrow consts, `use*` hooks, `export const X = {…}`,
      //           array literals, classes, plain function declarations
      // So a warning on a `const` is usually correct rather than noise: an
      // object or array initialiser gets a FRESH IDENTITY on re-evaluation, so
      // it fails the runtime's identity check exactly like a function would.
      // Only immutable primitives can be compared equal across a reload.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
];
