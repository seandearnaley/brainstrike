import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAIN_PROCESS_BUILD_OPTIONS,
  MAIN_PROCESS_ENTRY_POINTS,
} from '../../scripts/build-main-config.mjs';

interface DesktopPackageConfig {
  build?: {
    asarUnpack?: readonly string[];
    mac?: {
      extraResources?: readonly {
        filter?: readonly string[];
        from?: string;
        to?: string;
      }[];
    };
  };
  dependencies?: Record<string, string>;
}

function packagedTypeScriptServerViolations(packageJson: DesktopPackageConfig): string[] {
  const violations: string[] = [];
  if (packageJson.dependencies?.['@typescript/old'] !== 'catalog:') {
    violations.push('desktop must ship the classic TypeScript implementation as a dependency');
  }

  const asarUnpack = packageJson.build?.asarUnpack ?? [];
  for (const requiredPattern of [
    '**/node_modules/@typescript/old/**',
    '**/node_modules/typescript-language-server/**',
    '**/node_modules/typescript/**',
  ]) {
    if (!asarUnpack.includes(requiredPattern)) {
      violations.push(`desktop must unpack ${requiredPattern}`);
    }
  }
  return violations;
}

function readDesktopPackageConfig(): DesktopPackageConfig {
  return JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')
  ) as DesktopPackageConfig;
}

/**
 * Contract for the bundled main-process build (Electron performance checklist
 * recipe 7: "Bundle your code"). The runtime resolves these outputs by exact
 * path, so the entry list and output layout must stay pinned:
 * - package.json "main" → dist/main.js
 * - visible BrowserWindow preload → dist/preload.js
 * - hidden renderer host preload → dist/hidden-preload.js
 * - main-thread watchdog worker → dist/main-watchdog-worker.js
 * - utilityProcess.fork sibling lookups → dist/db-host-entry.js,
 *   dist/parser-host-entry.js (resolved through bundled-sibling-path from the
 *   running bundle's __filename, so outputs must stay FLAT in dist/)
 */
describe('main-process bundle config', () => {
  it('bundles every runtime and logging transport entry point', () => {
    expect(MAIN_PROCESS_ENTRY_POINTS).toEqual({
      'agent-host-entry': 'src/agent-host-entry.ts',
      'db-host-entry': 'src/db-host-entry.ts',
      'hidden-preload': 'src/hidden-preload.ts',
      'host-lease-entry': 'src/host-lease-entry.ts',
      'indexer-host-entry': 'src/indexer-host-entry.ts',
      main: 'src/main-bootstrap.ts',
      'main-log-transport': 'src/diagnostics/main-log-transport.ts',
      'main-watchdog-worker': 'src/diagnostics/main-watchdog-worker.ts',
      'official-conformance-client-entry': 'src/official-conformance-client-entry.ts',
      'parser-host-entry': 'src/parser-host-entry.ts',
      preload: 'src/preload.ts',
      'sqlite-query-host-entry': 'src/sqlite-query-host-entry.ts',
    });
  });

  it('unpacks worker-thread entries for plain packaged-worker paths', () => {
    const packageJson = readDesktopPackageConfig();

    expect(packageJson.build?.asarUnpack).toEqual(
      expect.arrayContaining(['dist/main-log-transport.js', 'dist/main-watchdog-worker.js'])
    );
  });

  it('packages the bundled Python manifest and only Darwin archives as macOS resources', () => {
    const packageJson = readDesktopPackageConfig();

    expect(packageJson.build?.mac?.extraResources).toContainEqual({
      filter: ['manifest.json', '*-apple-darwin-install_only.tar.gz'],
      from: 'resources/python-runtime',
      to: 'python-runtime',
    });
    expect(
      fs.existsSync(
        path.resolve(import.meta.dirname, '../../resources/python-runtime/manifest.json')
      )
    ).toBe(true);
  });

  it('ships and unpacks the classic TypeScript server used by LSP diagnostics', () => {
    expect(packagedTypeScriptServerViolations(readDesktopPackageConfig())).toEqual([]);
  });

  it('money test: an omitted TypeScript implementation or unpack rule fails loudly', () => {
    const packageJson = readDesktopPackageConfig();
    const mutatedPackage = {
      ...packageJson,
      build: {
        ...packageJson.build,
        asarUnpack: packageJson.build?.asarUnpack?.filter(
          (pattern) => pattern !== '**/node_modules/@typescript/old/**'
        ),
      },
      dependencies: { ...packageJson.dependencies, '@typescript/old': '^6' },
    };

    expect(packagedTypeScriptServerViolations(mutatedPackage)).toEqual([
      'desktop must ship the classic TypeScript implementation as a dependency',
      'desktop must unpack **/node_modules/@typescript/old/**',
    ]);
  });

  it('bundles app code only, as flat CJS for the Electron main process', () => {
    expect(MAIN_PROCESS_BUILD_OPTIONS.bundle).toBe(true);
    expect(MAIN_PROCESS_BUILD_OPTIONS.format).toBe('cjs');
    expect(MAIN_PROCESS_BUILD_OPTIONS.platform).toBe('node');
    // Bare imports (electron, node-pty, @brainstrike/* dist packages, every
    // node_modules dep) must stay external requires — bundling them would
    // change runtime resolution (native modules, agent-client-loader's
    // require.resolve probing) and duplicate prebuilt workspace bundles.
    expect(MAIN_PROCESS_BUILD_OPTIONS.packages).toBe('external');
    // Flat output directory keeps the fork-entry sibling lookups valid.
    expect(MAIN_PROCESS_BUILD_OPTIONS.outdir?.endsWith('dist')).toBe(true);
    expect(MAIN_PROCESS_BUILD_OPTIONS.outbase?.endsWith('src')).toBe(true);
  });

  it('emits the conformance entry as CJS and executes it without a silent module guard', () => {
    const entrySource = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../src/official-conformance-client-entry.ts'),
      'utf8'
    );

    expect(MAIN_PROCESS_BUILD_OPTIONS.format).toBe('cjs');
    expect(entrySource).toContain('void runOfficialConformanceProcess(');
    expect(entrySource).not.toContain("typeof require !== 'undefined'");
  });

  it('ignores the renderer tsconfig paths so workspace packages stay external', () => {
    // apps/desktop/tsconfig.json maps @brainstrike/* to SOURCE for the vite
    // renderer. esbuild auto-applies the nearest tsconfig's paths, which would
    // inline workspace package sources into the bundle and leak their own
    // dependencies as unresolvable requires (e.g. @brainstrike/indexing-contract
    // is not a dependency of @brainstrike/desktop — it crashed app launch).
    // An empty tsconfigRaw disables paths resolution for the bundle.
    expect(MAIN_PROCESS_BUILD_OPTIONS.tsconfigRaw).toBe('{}');
  });

  it('inlines the audited ESM-only main-process subpaths from source', () => {
    const aliases = MAIN_PROCESS_BUILD_OPTIONS.alias as Record<string, string>;
    expect(Object.keys(aliases)).toEqual([
      '@brainstrike/assistant-data/assistant-memory-repository',
      '@brainstrike/assistant-data/assistant-thread-run-reaper',
      '@brainstrike/notes-vault/core',
      '@brainstrike/workspace-search/core',
    ]);
    expect(
      aliases['@brainstrike/assistant-data/assistant-thread-run-reaper']?.endsWith(
        path.join('packages', 'assistant-data', 'src', 'assistant-thread-run-reaper.ts')
      )
    ).toBe(true);
    expect(
      aliases['@brainstrike/assistant-data/assistant-memory-repository']?.endsWith(
        path.join('packages', 'assistant-data', 'src', 'assistant-memory-repository.ts')
      )
    ).toBe(true);
    expect(
      aliases['@brainstrike/notes-vault/core']?.endsWith(
        path.join('packages', 'notes-vault', 'src', 'core', 'index.ts')
      )
    ).toBe(true);
    expect(
      aliases['@brainstrike/workspace-search/core']?.endsWith(
        path.join('packages', 'workspace-search', 'src', 'core', 'index.ts')
      )
    ).toBe(true);
  });
});
