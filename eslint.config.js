// Minimal ESLint flat config to surface React Compiler diagnostics only
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    files: [
      'apps/web/src/**/*.{js,jsx,ts,tsx}',
      'packages/ui/src/**/*.{js,jsx,ts,tsx}',
      'packages/file-explorer-ui/src/**/*.{js,jsx,ts,tsx}',
      'packages/file-explorer-hooks/src/**/*.{js,jsx,ts,tsx}',
    ],
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/*.d.ts',
      '**/__tests__/**',
      '**/*.test.*',
      '**/*.test.*',
    ],
    languageOptions: {
      parser: tsParser,
      sourceType: 'module',
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/exhaustive-deps': 'off',
      // Note: react-compiler rule removed as it doesn't exist in eslint-plugin-react-hooks v6.1.1
      // React Compiler is still enabled via babel-plugin-react-compiler in vite.config
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  // Previously downgraded compiler rule for known dev-only opt-outs
  // Removed as react-compiler rule doesn't exist in eslint-plugin-react-hooks v6.1.1
];
