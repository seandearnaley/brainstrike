import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  resolveThroughAliases,
  workspaceSrcAliases,
} from '@brainstrike/test-utils/workspace-src-aliases';
import { describe, expect, it } from 'vitest';

function readDesktopViteConfig(): string {
  return readFileSync(path.resolve(process.cwd(), 'vite.config.mts'), 'utf8');
}

function readWebViteConfig(): string {
  return readFileSync(path.resolve(process.cwd(), '../web/vite.config.mts'), 'utf8');
}

const PACKAGES_DIR = path.resolve(process.cwd(), '../../packages');

/**
 * Registry entries. Deliberately NOT loading the real vite.config.mts here
 * (e.g. via Vite's `loadConfigFromFile`): that file's own top-level imports
 * (`@brainstrike/build-utils`, `@brainstrike/utils`) require those packages'
 * built `dist` to even load, which would make this test — unlike every other
 * test in this suite since B4 dropped `test.dependsOn: ["^build"]` — silently
 * require a prior build. Testing the shared registry function directly
 * verifies the exact same resolution behavior these configs spread
 * (`...workspaceSrcAliases(...)`) without that dependency; the text
 * assertions below separately confirm each config actually spreads it and
 * does not shadow these specifiers with a stale local override.
 */
const registryEntries = workspaceSrcAliases(PACKAGES_DIR);

describe('desktop vite config alias contract', () => {
  it('keeps the documented production chunk warning ceiling', () => {
    const config = readDesktopViteConfig();

    expect(config).toContain('chunkSizeWarningLimit: 1300');
  });

  it('filters only CSP-qualified dependency eval warnings', () => {
    const config = readDesktopViteConfig();

    expect(config).toContain('createCspQualifiedEvalWarningFilter,');
    expect(config).toContain('onLog: createCspQualifiedEvalWarningFilter()');
  });

  it('spreads the shared workspace-src-alias registry', () => {
    const config = readDesktopViteConfig();

    expect(config).toContain('workspaceSrcAliases(');
  });

  it('resolves token-cache runtime imports to source entries via the registry', () => {
    expect(resolveThroughAliases('@brainstrike/token-cache/cache-runtime', registryEntries)).toBe(
      path.resolve(PACKAGES_DIR, 'token-cache/src/cache-runtime.ts')
    );
    expect(
      resolveThroughAliases('@brainstrike/token-cache/background-indexer', registryEntries)
    ).toBe(path.resolve(PACKAGES_DIR, 'token-cache/src/background-indexer.ts'));
    // And the config itself carries no stale local override that would shadow it.
    expect(readDesktopViteConfig()).not.toMatch(/find:\s*'@brainstrike\/token-cache/);
  });

  it('resolves text-splitter and tokenization subpaths from their owning packages', () => {
    for (const [specifier, packageName, sourcePath] of [
      ['@brainstrike/text-splitter/chunking-core', 'text-splitter', 'chunking-core.ts'],
      [
        '@brainstrike/tokenization/token-utils-accurate-lite',
        'tokenization',
        'token-utils-accurate-lite.ts',
      ],
      ['@brainstrike/tokenization/token-utils-lite', 'tokenization', 'token-utils-lite.ts'],
    ] as const) {
      expect(resolveThroughAliases(specifier, registryEntries)).toBe(
        path.resolve(PACKAGES_DIR, `${packageName}/src/${sourcePath}`)
      );
    }
    expect(resolveThroughAliases('@brainstrike/text-splitter', registryEntries)).toBe(
      path.resolve(PACKAGES_DIR, 'text-splitter/src/index.ts')
    );
    expect(readDesktopViteConfig()).not.toMatch(/find:\s*'@brainstrike\/text-splitter/);
    expect(readDesktopViteConfig()).not.toMatch(/find:\s*'@brainstrike\/tokenization/);
  });

  it('pins file-tree-worker to source so renderer dev does not load stale dist workers', () => {
    // Deliberate LOCAL override: file-tree-worker's package.json root export
    // targets a Node-worker_threads dist entry, so the registry would derive
    // that same Node-targeted src/index.ts — this app needs the
    // browser-adapted vite.ts implementation instead. Text-checked (not
    // execution-checked) since it is not registry-derived.
    const config = readDesktopViteConfig();

    expect(config).toMatch(
      /find:\s*'@brainstrike\/file-tree-worker'[\s\S]{0,120}replacement:\s*path\.resolve\(\s*__dirname,\s*'\.\.\/\.\.\/packages\/file-tree-worker\/src\/vite\.ts'\s*\)/
    );
    expect(config).not.toContain('../../packages/file-tree-worker/dist');
  });

  it('keeps the source-aliased file-explorer module Worker resolvable as ESM', () => {
    expect(resolveThroughAliases('@brainstrike/file-explorer', registryEntries)).toBe(
      path.resolve(PACKAGES_DIR, 'file-explorer/src/index.ts')
    );

    const workerStorageSource = readFileSync(
      path.resolve(PACKAGES_DIR, 'file-explorer/src/persistence/worker-storage.ts'),
      'utf8'
    );
    expect(workerStorageSource).toContain("'./worker-storage.worker.mjs'");
    expect(
      existsSync(
        path.resolve(PACKAGES_DIR, 'file-explorer/src/persistence/worker-storage.worker.mjs')
      )
    ).toBe(true);
  });

  it('aliases @brainstrike/workers subpaths explicitly (no src/ dir, registry skips it)', () => {
    const config = readDesktopViteConfig();

    expect(config).toMatch(/find:\s*'@brainstrike\/workers'/);
    expect(resolveThroughAliases('@brainstrike/workers', registryEntries)).toBeNull();
  });

  it('source-aliases context-actions + commands in BOTH renderer vite configs via the registry (chunk-init TDZ)', () => {
    // Resolving these to their built `dist` (instead of source, like every other
    // @brainstrike package) lands `defineContextAction` in a separate chunk from
    // the source feature `*/context-actions` that call it at module-init →
    // circular chunk-init TDZ ("t is not a function") that hangs the BUILT
    // renderer on startup forever (dev is unaffected; caught only by live
    // built-app verification / the Desktop E2E smoke). They MUST resolve to src.
    const systemEntrypoints = [
      ['@brainstrike/context-actions', 'context-actions/src/index.ts'],
      ['@brainstrike/context-actions/commands', 'context-actions/src/commands/index.ts'],
    ] as const;
    for (const [specifier, sourcePath] of systemEntrypoints) {
      const resolved = resolveThroughAliases(specifier, registryEntries);
      expect(resolved).toBe(path.resolve(PACKAGES_DIR, sourcePath));
      // Anchored on path separators. A bare /dist/ against the absolute
      // result also matched any ancestor directory of the checkout — this
      // app generates worktrees named like `distracted-wilson-24fa2d` — so
      // the lane failed on the machine path rather than on the resolution
      // this line exists to guard.
      expect(resolved).not.toMatch(/[/\\]dist[/\\]/);
    }
    // Both configs spread the shared registry and neither shadows these two
    // with a stale literal override.
    for (const config of [readDesktopViteConfig(), readWebViteConfig()]) {
      expect(config).toContain('workspaceSrcAliases(');
      expect(config).not.toMatch(/find:\s*'@brainstrike\/context-actions/);
    }
  });

  it('uses a dedicated strict dev-server port for the desktop renderer', () => {
    const config = readDesktopViteConfig();

    expect(config).toContain(
      "import { DESKTOP_DEV_RENDERER_PORT } from './src/desktop-renderer-url';"
    );
    expect(config).toContain('port: DESKTOP_DEV_RENDERER_PORT');
    expect(config).toContain('strictPort: true');
  });

  it('warms the desktop renderer entry during dev-server startup', () => {
    const config = readDesktopViteConfig();

    expect(config).toContain('warmup: {');
    expect(config).toContain("clientFiles: ['./src/renderer/main.tsx']");
  });
});
