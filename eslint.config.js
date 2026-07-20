// ESLint flat config: rules-of-hooks + React Compiler diagnostics.
// Base: eslint-plugin-react-hooks v7 `recommended-latest` flat preset
// (reactHooks.configs.flat['recommended-latest']), which ships the compiler
// diagnostic ruleset (purity, refs, immutability, set-state-in-effect, ...).
// The React Compiler runs in production for both apps (compilationMode
// 'infer' via babel-plugin-react-compiler in vite.config); these rules are
// its lint-time instrument.
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

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
// replaced by useEventCallback, clearing 3 react-hooks/refs warnings.)
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
      'packages/db/src/**/*.{js,jsx,ts,tsx}',
      'packages/file-import/src/**/*.{js,jsx,ts,tsx}',
      'packages/notes-vault/src/**/*.{js,jsx,ts,tsx}',
      'packages/preferences/src/**/*.{js,jsx,ts,tsx}',
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
    },
    rules: {
      ...compilerDiagnosticsAsWarnings,
      // Deliberate stance: dependency-array linting is intentionally absent
      // repo-wide. Biome's useExhaustiveDependencies is off for React dirs by
      // design; the React Compiler (which memoizes without dependency arrays)
      // and @jacobwolf/biome-unnecessary-effect are the compensating controls.
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
];
