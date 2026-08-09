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

// Compiler diagnostics run as WARNINGS for now, budgeted by --max-warnings
// in the root `lint:eslint` script. Burning the warning wave down is
// downstream work (BST-575 B2-B5) — do not add suppression comments to
// source files to dodge the ratchet. The budget is a CEILING: every
// burn-down PR must also LOWER the --max-warnings number to the new count,
// or regressions can creep back invisibly inside the slack. (Re-baselined
// 196→197: a merge in flight when the ratchet landed (#1790) was measured
// after the fact — the ceiling race is expected; re-baseline with a note.
// Burned 197→194: #1764's render-phase ref writes in use-file-system-watcher
// replaced by useEventCallback, clearing 3 react-hooks/refs warnings.
// Re-baselined 194→341 (#2372) when react-refresh/only-export-components
// joined this ratchet: 155 new Fast Refresh boundary warnings across 77 files,
// PLUS closing 8 warnings of accumulated slack — the compiler-diagnostic count
// had drifted to 186 while the ceiling still read 194, which is exactly the
// invisible-regression window this comment warns about. 186 + 155 = 341.
// The ceiling race bit again on the way in: measured at 161/78, then #2368
// landed mid-flight and split file-explorer-panel-toolbar-helpers.tsx, clearing
// exactly 6. Re-measure after any rebase before pushing a ratchet change.)
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
      // Fast Refresh module-boundary contract (#2372). This is the REAL
      // enforcer: react-doctor's `only-export-components` id exists only in its
      // oxlint→react-doctor alias table with no rule behind it, so the many
      // source comments citing it were describing an unenforced convention.
      // See the REACT DOCTOR section in docs/agents/ci-quality.md.
      //
      // Semantics deliberately match @vitejs/plugin-react's runtime check
      // (`validateRefreshBoundaryAndEnqueueUpdate`), which accepts an export
      // when it is component-like OR its identity is unchanged: only EXPORTED
      // plain functions and hooks break the boundary. Biome's
      // `useComponentExportOnlyModules` was rejected for this job — it also
      // flags unexported components (63 sites, not a defect: the runtime walks
      // `moduleExports` only) and misreads `export default <Component>` aliases
      // (29 false positives).
      //
      // `allowConstantExport` matches Vite, which tolerates constant exports.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
];
