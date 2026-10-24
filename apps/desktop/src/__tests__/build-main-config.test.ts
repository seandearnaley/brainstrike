import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_HOST_PLATFORM_BUILD_OPTIONS,
  MAIN_PROCESS_BUILD_OPTIONS,
  MAIN_PROCESS_ENTRY_POINTS,
  NODE_BUILDS,
  WINDOWS_COMMAND_BUILD_OPTIONS,
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
  scripts?: Record<string, string>;
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
 * - utilityProcess.fork sibling lookups → dist/indexer-host-entry.js (resolved
 *   through bundled-sibling-path from the running bundle's __filename, so
 *   outputs must stay FLAT in dist/)
 */
describe('main-process bundle config', () => {
  it('bundles every runtime and logging transport entry point', () => {
    expect(MAIN_PROCESS_ENTRY_POINTS).toEqual({
      'agent-egress-entry': 'src/agent-egress-entry.ts',
      'agent-host-entry': 'src/agent-host-entry.ts',
      'desktop-bootstrap-runtime': 'src/desktop-bootstrap-runtime.ts',
      'desktop-database-location': 'src/desktop-database-location.ts',
      'desktop-env': 'src/desktop-env.ts',
      'desktop-shutdown-state': 'src/desktop-shutdown-state.ts',
      'hidden-preload': 'src/hidden-preload.ts',
      'host-lease-entry': 'src/host-lease-entry.ts',
      'indexer-host-entry': 'src/indexer-host-entry.ts',
      'lifecycle-delay-seam': 'src/lifecycle-delay-seam.ts',
      main: 'src/main-bootstrap.ts',
      'main-log-transport': 'src/diagnostics/main-log-transport.ts',
      'main-runtime': 'src/main.ts',
      'main-watchdog-worker': 'src/diagnostics/main-watchdog-worker.ts',
      preload: 'src/preload.ts',
      'sqlite-query-host-entry': 'src/sqlite-query-host-entry.ts',
    });
    expect(AGENT_HOST_PLATFORM_BUILD_OPTIONS.entryPoints).toEqual({
      'agent-host-platform-entry': 'src/agent-host-platform-entry.ts',
    });
  });

  it('emits every Node entry from build-main.mjs, so its inference gate scans them all', () => {
    // BST-2148: a step after build-main.mjs would emit an entry the gate never sees.
    expect(NODE_BUILDS).toEqual([
      MAIN_PROCESS_BUILD_OPTIONS,
      AGENT_HOST_PLATFORM_BUILD_OPTIONS,
      WINDOWS_COMMAND_BUILD_OPTIONS,
    ]);
    expect(readDesktopPackageConfig().scripts?.['build:main']).toBe('node scripts/build-main.mjs');
  });

  it('builds the Windows command wrapper self-contained but for its native Job addon', () => {
    expect(WINDOWS_COMMAND_BUILD_OPTIONS).toMatchObject({
      bundle: true,
      entryPoints: { 'windows-command-entry': 'src/windows-command-entry.ts' },
      external: ['@brainstrike/windows-job-native'],
      format: 'cjs',
      packages: 'bundle',
      platform: 'node',
      target: 'node24',
      tsconfigRaw: '{}',
    });
    expect(WINDOWS_COMMAND_BUILD_OPTIONS.outdir).toBe(MAIN_PROCESS_BUILD_OPTIONS.outdir);
  });

  it('unpacks worker-thread entries for plain packaged-worker paths', () => {
    const packageJson = readDesktopPackageConfig();

    expect(packageJson.build?.asarUnpack).toEqual(
      expect.arrayContaining(['dist/main-log-transport.js', 'dist/main-watchdog-worker.js'])
    );
  });

  it('packages the bundled Python manifest plus the per-arch build-time unpack as macOS resources', () => {
    const packageJson = readDesktopPackageConfig();

    // BST-1627: the tarballs themselves must NOT ship. Apple's notarization
    // service scans inside archives and rejects python-build-standalone's
    // ad-hoc-signed Mach-O files, so the interpreter is unpacked at build
    // time and copied as loose files that osx-sign signs with our identity.
    expect(packageJson.build?.mac?.extraResources).toEqual([
      { filter: ['manifest.json'], from: 'resources/python-runtime', to: 'python-runtime' },
      {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder macro, expanded by its FileMatcher
        from: 'resources/python-runtime/unpacked/darwin-${arch}',
        to: 'python-runtime',
      },
    ]);
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
    // change runtime resolution (native modules) and duplicate prebuilt
    // workspace bundles.
    expect(MAIN_PROCESS_BUILD_OPTIONS.packages).toBe('external');
    // Flat output directory keeps the fork-entry sibling lookups valid.
    expect(MAIN_PROCESS_BUILD_OPTIONS.outdir?.endsWith('dist')).toBe(true);
    expect(MAIN_PROCESS_BUILD_OPTIONS.outbase?.endsWith('src')).toBe(true);
  });

  it('ignores the renderer tsconfig so workspace packages stay external', () => {
    // esbuild auto-applies the nearest tsconfig. apps/desktop/tsconfig.json
    // configures the renderer's type-check; an empty tsconfigRaw keeps it out of
    // the Node bundle.
    expect(MAIN_PROCESS_BUILD_OPTIONS.tsconfigRaw).toBe('{}');
  });

  it('inlines the audited ESM-only main-process subpaths from source', () => {
    const aliases = MAIN_PROCESS_BUILD_OPTIONS.alias as Record<string, string>;
    expect(Object.keys(aliases)).toEqual([
      '@brainstrike/assistant-data/assistant-memory-repository',
      '@brainstrike/assistant-data/assistant-memory-resource',
      '@brainstrike/types/catalog-args',
      '@brainstrike/workspace-search/core',
    ]);
    expect(
      aliases['@brainstrike/assistant-data/assistant-memory-repository']?.endsWith(
        path.join('packages', 'assistant-data', 'src', 'assistant-memory-repository.ts')
      )
    ).toBe(true);
    // The host platform entry's memory resource constant (BST-1928).
    expect(
      aliases['@brainstrike/assistant-data/assistant-memory-resource']?.endsWith(
        path.join('packages', 'assistant-data', 'src', 'assistant-memory-resource.ts')
      )
    ).toBe(true);
    expect(
      aliases['@brainstrike/types/catalog-args']?.endsWith(
        path.join('packages', 'types', 'src', 'catalog-args', 'index.ts')
      )
    ).toBe(true);
    expect(
      aliases['@brainstrike/workspace-search/core']?.endsWith(
        path.join('packages', 'workspace-search', 'src', 'core', 'index.ts')
      )
    ).toBe(true);
  });
});
