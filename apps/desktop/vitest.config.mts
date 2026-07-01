import { readFileSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { getAdjustedTimeout } from '../../packages/test-utils/src/test-timeouts';

const coverageEnabled = process.env['CI'] === 'true' || process.env['COVERAGE'] === 'true';
interface VitestAliasEntry {
  find: string | RegExp;
  replacement: string;
}

type PackageExportTarget =
  | string
  | {
      import?: string;
      require?: string;
      types?: string;
    };

interface PackageJsonWithExports {
  exports?: Record<string, PackageExportTarget>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourcePathFromExportTarget(
  packageName: string,
  subpath: string,
  target: PackageExportTarget
) {
  const targetPath =
    typeof target === 'string' ? target : (target.import ?? target.require ?? target.types);
  if (!targetPath) {
    throw new Error(`${packageName}${subpath} has no import, require, or types export target`);
  }

  const distPath = targetPath.replace(/^\.\//, '');
  if (!distPath.startsWith('dist/')) {
    throw new Error(`${packageName}${subpath} export must point at dist, got ${targetPath}`);
  }

  return distPath
    .replace(/^dist\//, 'src/')
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.(mjs|cjs|js)$/, '.ts');
}

function createPackageSourceAliasEntries(
  packageName: string,
  packageDir: string
): VitestAliasEntry[] {
  const packageJson = JSON.parse(
    readFileSync(path.resolve(packageDir, 'package.json'), 'utf8')
  ) as PackageJsonWithExports;

  if (!packageJson.exports) {
    throw new Error(`${packageName} must declare package.json exports for source aliases`);
  }

  return Object.entries(packageJson.exports).map(([subpath, target]) => {
    const importSpecifier =
      subpath === '.' ? packageName : `${packageName}/${subpath.replace(/^\.\//, '')}`;

    return {
      find: new RegExp(`^${escapeRegExp(importSpecifier)}$`),
      replacement: path.resolve(
        packageDir,
        sourcePathFromExportTarget(packageName, subpath, target)
      ),
    };
  });
}

const agentDir = path.resolve(import.meta.dirname, '../../packages/agent');
const assistantContractDir = path.resolve(import.meta.dirname, '../../packages/assistant-contract');
const assistantContractAliasEntries = createPackageSourceAliasEntries(
  '@brainstrike/assistant-contract',
  assistantContractDir
);
const utilsDir = path.resolve(import.meta.dirname, '../../packages/utils');
const utilsAliasEntries = createPackageSourceAliasEntries('@brainstrike/utils', utilsDir);
const dbAliasEntries = createPackageSourceAliasEntries(
  '@brainstrike/db',
  path.resolve(import.meta.dirname, '../../packages/db')
);
const embeddingsAliasEntries = createPackageSourceAliasEntries(
  '@brainstrike/embeddings',
  path.resolve(import.meta.dirname, '../../packages/embeddings')
);
const queueAliasEntries = createPackageSourceAliasEntries(
  '@brainstrike/queue',
  path.resolve(import.meta.dirname, '../../packages/queue')
);
const textSplitterAliasEntries = createPackageSourceAliasEntries(
  '@brainstrike/text-splitter',
  path.resolve(import.meta.dirname, '../../packages/text-splitter')
);
const typesAliasEntries = createPackageSourceAliasEntries(
  '@brainstrike/types',
  path.resolve(import.meta.dirname, '../../packages/types')
);
const indexingContractAliasEntries = createPackageSourceAliasEntries(
  '@brainstrike/indexing-contract',
  path.resolve(import.meta.dirname, '../../packages/indexing-contract')
);

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['../../packages/test-utils/src/vitest.setup.ts', './src/__tests__/setup.ts'],
    globals: true,
    testTimeout: getAdjustedTimeout('uiComponent'),
    // Use threads pool to avoid process forks (prevents EPERM kills in constrained sandboxes)
    pool: 'threads',
    server: {
      deps: {
        // Force `electron` through Vite's transform pipeline so the
        // `resolve.alias` stub applies during `vi.mock('electron', …)`
        // resolution too — not just plain `import` statements. Without this,
        // the mocker resolves the bare specifier to the real
        // node_modules/electron/index.js and evaluates it, which throws when
        // the prebuilt binary is absent (cache-miss CI lanes).
        inline: ['electron'],
      },
    },
    // Desktop tests spin up mocked Electron, PGlite, MCP, and renderer-host
    // surfaces with process-wide module state. Keep this package serialized so
    // those globals cannot bleed across files under load.
    maxWorkers: 1,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**', // Exclude Playwright e2e tests
      '**/scripts/**', // Script helper tests use node:test directly.
    ],
    // Package-local coverage for reliability (root still consolidates)
    coverage: {
      enabled: coverageEnabled,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.*',
        '**/__tests__/**',
        '**/dist/**',
        '**/node_modules/**',
        '**/e2e/**',
        'src/main.ts',
        'src/preload.ts',
      ],
    },
  },
  resolve: {
    alias: [
      // The real `electron` entrypoint only exports the binary path and throws
      // when the prebuilt binary is absent (e.g. cache-miss CI lanes). Tests
      // never need the runtime module — they `vi.mock('electron', …)` — so
      // alias it to an inert stub. This keeps desktop unit tests independent of
      // the Electron binary being installed. See electron-test-stub.mts.
      {
        find: 'electron',
        replacement: path.resolve(import.meta.dirname, './src/__tests__/electron-test-stub.mts'),
      },
      { find: '@', replacement: path.resolve(import.meta.dirname, './src/renderer') },
      ...createPackageSourceAliasEntries('@brainstrike/agent', agentDir),
      ...assistantContractAliasEntries,
      ...utilsAliasEntries,
      ...typesAliasEntries,
      ...indexingContractAliasEntries,
      {
        find: '@brainstrike/platform-utils',
        replacement: path.resolve(import.meta.dirname, '../../packages/platform-utils/src'),
      },
      ...dbAliasEntries,
      ...embeddingsAliasEntries,
      ...queueAliasEntries,
      {
        find: '@brainstrike/file-import/browser-queue-port',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/file-import/src/browser-queue-port.ts'
        ),
      },
      {
        find: '@brainstrike/file-import/chunking-worker-context',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/file-import/src/chunking-worker-context.tsx'
        ),
      },
      {
        find: '@brainstrike/file-import/enhanced-import',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/file-import/src/enhanced-import.ts'
        ),
      },
      {
        find: '@brainstrike/file-explorer-ui/indexing',
        replacement: path.resolve(
          import.meta.dirname,
          '../../packages/file-explorer-ui/src/indexing'
        ),
      },
      {
        find: '@brainstrike/file-explorer-ui/shell',
        replacement: path.resolve(import.meta.dirname, '../../packages/file-explorer-ui/src/shell'),
      },
      ...textSplitterAliasEntries,
      {
        find: '@brainstrike/test-utils',
        replacement: path.resolve(import.meta.dirname, '../../packages/test-utils/src'),
      },
    ],
  },
});
