// Minimal ESLint flat config to surface React Compiler diagnostics only
import tsParser from '@typescript-eslint/parser';
import * as reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: [
      'apps/web/src/**/*.{js,jsx,ts,tsx}',
      'packages/ui/src/**/*.{js,jsx,ts,tsx}',
      'packages/file-explorer-ui/src/**/*.{js,jsx,ts,tsx}',
      'packages/file-explorer-hooks/src/**/*.{js,jsx,ts,tsx}'
    ],
    languageOptions: {
      parser: tsParser,
      sourceType: 'module'
    },
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.d.ts',
      '**/__tests__/**',
      '**/*.test.*',
      '**/*.spec.*'
    ],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/react-compiler': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off'
    }
  },
  // Temporarily downgrade compiler rule for known dev-only opt-outs while we iterate
  {
    files: [
      'packages/file-explorer-ui/src/file-explorer-config.tsx',
      'packages/file-explorer-ui/src/file-explorer-middle-panel-tabbed.tsx',
      'packages/file-explorer-ui/src/file-explorer-middle-panel.tsx',
      'packages/file-explorer-ui/src/use-file-system-context.ts',
      'packages/file-explorer-ui/src/use-selection-manager-context.ts'
    ],
    rules: {
      'react-hooks/react-compiler': 'warn'
    }
  }
];


