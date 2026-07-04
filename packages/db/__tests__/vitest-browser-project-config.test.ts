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
 */

interface InlineProjectShape {
  readonly define?: Readonly<Record<string, unknown>>;
  readonly optimizeDeps?: {
    readonly exclude?: readonly string[];
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
});
