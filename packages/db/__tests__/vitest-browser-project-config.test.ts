import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config.mts';

/**
 * Vitest inline `projects` do NOT inherit top-level Vite options (the config
 * duplicates `resolve.alias` into each project for the same reason). The
 * browser project must therefore carry its own `optimizeDeps.exclude` and
 * `define` entries: without the exclusions the dep optimizer bundles
 * `@tursodatabase/database-wasm` into a single esbuild artifact that leaves
 * `@tybys/wasm-util` as a bare import, which fails at runtime with
 * "Failed to fetch dynamically imported module" during store open.
 *
 * The browser project must ALSO pin the @emnapi/* modules to the exact
 * versions @tursodatabase/database-wasm-common declares: the package's emnapi
 * imports flow through @napi-rs/wasm-runtime, whose looser semver range
 * resolves a NEWER @emnapi/core whose rewritten async-work `initWorkers`
 * dereferences `PThread.pthreads[tid].whenLoaded` and faults DETERMINISTICALLY
 * against turso's wasm binary — store open never succeeds. The aliases below
 * are asserted against database-wasm-common's own dependency pins so a vendor
 * upgrade keeps them honest.
 */

const dbPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface InlineProjectShape {
  readonly define?: Readonly<Record<string, unknown>>;
  readonly optimizeDeps?: {
    readonly exclude?: readonly string[];
  };
  readonly resolve?: {
    readonly alias?: Readonly<Record<string, string>>;
  };
  readonly test?: {
    readonly name?: string;
    readonly testTimeout?: number;
  };
}

function getBrowserProject(): InlineProjectShape {
  const config = vitestConfig as {
    readonly test?: { readonly projects?: readonly unknown[] };
  };
  const projects = config.test?.projects ?? [];
  const browserProject = projects.find(
    (project): project is InlineProjectShape =>
      typeof project === 'object' &&
      project !== null &&
      (project as InlineProjectShape).test?.name === 'browser'
  );
  if (!browserProject) {
    throw new Error('vitest.config.mts must declare an inline browser project.');
  }
  return browserProject;
}

describe('vitest browser project inline config', () => {
  it('excludes the Turso WASM packages from dep optimization inside the browser project', () => {
    const browserProject = getBrowserProject();
    expect(browserProject.optimizeDeps?.exclude).toEqual(
      expect.arrayContaining([
        '@tursodatabase/database-wasm',
        '@tursodatabase/database-wasm-common',
      ])
    );
  });

  it('duplicates the NODE_DEBUG_NATIVE define into the browser project', () => {
    const browserProject = getBrowserProject();
    expect(browserProject.define).toMatchObject({
      'process.env.NODE_DEBUG_NATIVE': 'false',
    });
  });

  it('allows slow WASM/worker startup with a 120s browser test timeout', () => {
    const browserProject = getBrowserProject();
    expect(browserProject.test?.testTimeout).toBe(120_000);
  });

  it('aliases the @emnapi modules to the exact versions database-wasm-common pins', () => {
    const browserProject = getBrowserProject();
    const alias = browserProject.resolve?.alias ?? {};

    const wasmCommonDir = resolvePackageDir(
      '@tursodatabase/database-wasm-common',
      resolvePackageDir('@tursodatabase/database-wasm', dbPackageDir)
    );
    const wasmCommonDependencies = readPackageJson(wasmCommonDir).dependencies ?? {};
    const pinnedCoreVersion = wasmCommonDependencies['@emnapi/core'];
    const pinnedRuntimeVersion = wasmCommonDependencies['@emnapi/runtime'];
    expect(pinnedCoreVersion).toMatch(/^\d/);
    expect(pinnedRuntimeVersion).toMatch(/^\d/);

    const aliasedCore = expectAliasedFile(alias, '@emnapi/core');
    const aliasedRuntime = expectAliasedFile(alias, '@emnapi/runtime');
    const aliasedWasiThreads = expectAliasedFile(alias, '@emnapi/wasi-threads');

    const aliasedCoreDir = packageDirContaining(aliasedCore, '@emnapi/core');
    const aliasedCorePkg = readPackageJson(aliasedCoreDir);
    expect(aliasedCorePkg.version).toBe(pinnedCoreVersion);
    expect(readPackageJson(packageDirContaining(aliasedRuntime, '@emnapi/runtime')).version).toBe(
      pinnedRuntimeVersion
    );
    // wasi-threads is pinned by the aliased @emnapi/core itself.
    expect(
      readPackageJson(packageDirContaining(aliasedWasiThreads, '@emnapi/wasi-threads')).version
    ).toBe(aliasedCorePkg.dependencies?.['@emnapi/wasi-threads']);
  });
});

interface PackageJsonShape {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly version?: string;
}

function readPackageJson(packageDir: string): PackageJsonShape {
  return JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')
  ) as PackageJsonShape;
}

/**
 * Node-style node_modules walk (the packages in the turso wasm chain expose
 * import-only `exports`, so createRequire cannot resolve them directly).
 */
function resolvePackageDir(packageName: string, fromDir: string): string {
  let dir = fs.realpathSync(fromDir);
  for (;;) {
    const base = path.basename(dir) === 'node_modules' ? dir : path.join(dir, 'node_modules');
    const candidate = path.join(base, ...packageName.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return fs.realpathSync(candidate);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not resolve package ${packageName} from ${fromDir}.`);
    }
    dir = parent;
  }
}

function packageDirContaining(filePath: string, packageName: string): string {
  let dir = path.dirname(filePath);
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as PackageJsonShape;
      if (pkg.name === packageName) {
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate the ${packageName} package root from ${filePath}.`);
    }
    dir = parent;
  }
}

function expectAliasedFile(alias: Readonly<Record<string, string>>, specifier: string): string {
  const aliased = alias[specifier];
  if (typeof aliased !== 'string' || !path.isAbsolute(aliased) || !fs.existsSync(aliased)) {
    throw new Error(
      `Browser project must alias ${specifier} to an existing absolute ESM file (got ${String(aliased)}).`
    );
  }
  return aliased;
}
