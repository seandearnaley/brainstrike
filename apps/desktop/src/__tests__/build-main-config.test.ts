import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NODE_BUILDS,
  NODE_PROCESS_BUILD_OPTIONS,
  PRELOAD_BUILD_OPTIONS,
  STATE_STORE_WRITER_BUILD_OPTIONS,
  UNPACKED_WORKER_BUILD_OPTIONS,
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
 * Contract for the bundled Node-side build. The runtime resolves its outputs by
 * exact path from the running bundle's own location (bundled-sibling-path), so
 * every output stays flat in dist/: package.json "main" -> dist/main.js, the
 * preload -> dist/preload.cjs, utilityProcess.fork targets -> dist/*-entry.js.
 */
describe('Node-side bundle config', () => {
  it('emits every Node entry from build-main.mjs into the flat dist/', () => {
    expect(NODE_BUILDS).toEqual([
      NODE_PROCESS_BUILD_OPTIONS,
      STATE_STORE_WRITER_BUILD_OPTIONS,
      UNPACKED_WORKER_BUILD_OPTIONS,
      PRELOAD_BUILD_OPTIONS,
      WINDOWS_COMMAND_BUILD_OPTIONS,
    ]);
    expect(readDesktopPackageConfig().scripts?.['build:main']).toBe('node scripts/build-main.mjs');
    for (const options of NODE_BUILDS) {
      expect(options.outdir).toBe(NODE_PROCESS_BUILD_OPTIONS.outdir);
    }
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
        ...(packageJson.build?.asarUnpack === undefined
          ? {}
          : {
              asarUnpack: packageJson.build.asarUnpack.filter(
                (pattern) => pattern !== '**/node_modules/@typescript/old/**'
              ),
            }),
      },
      dependencies: { ...packageJson.dependencies, '@typescript/old': '^6' },
    };

    expect(packagedTypeScriptServerViolations(mutatedPackage)).toEqual([
      'desktop must ship the classic TypeScript implementation as a dependency',
      'desktop must unpack **/node_modules/@typescript/old/**',
    ]);
  });

  it('ignores the renderer tsconfig', () => {
    // esbuild auto-applies the nearest tsconfig. apps/desktop/tsconfig.json
    // configures the renderer's type-check; an empty tsconfigRaw keeps it out of
    // every Node bundle.
    for (const options of NODE_BUILDS) {
      expect(options.tsconfigRaw).toBe('{}');
    }
  });
});
