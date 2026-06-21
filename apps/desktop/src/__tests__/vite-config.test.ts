import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readDesktopViteConfig(): string {
  return readFileSync(path.resolve(process.cwd(), 'vite.config.mts'), 'utf8');
}

describe('desktop vite config alias contract', () => {
  it('pins token-cache runtime imports to source entries', () => {
    const config = readDesktopViteConfig();

    expect(config).toContain("find: '@brainstrike/token-cache/cache-runtime'");
    expect(config).toContain('../../packages/token-cache/src/cache-runtime.ts');
    expect(config).toContain("find: '@brainstrike/token-cache/background-indexer'");
    expect(config).toContain('../../packages/token-cache/src/background-indexer.ts');
  });

  it('pins selection-rules to the workspace source entry', () => {
    const config = readDesktopViteConfig();

    expect(config).toContain("find: '@brainstrike/selection-rules'");
    expect(config).toContain('../../packages/selection-rules/src/index.ts');
  });

  it('pins text-splitter subpath imports before the root source alias', () => {
    const config = readDesktopViteConfig();
    const rootAliasIndex = config.indexOf("find: '@brainstrike/text-splitter'");

    for (const [specifier, sourcePath] of [
      ['@brainstrike/text-splitter/chunking-core', 'chunking-core.ts'],
      ['@brainstrike/text-splitter/token-counting-heuristics', 'token-counting-heuristics.ts'],
      ['@brainstrike/text-splitter/token-constants', 'token-constants.ts'],
      ['@brainstrike/text-splitter/token-utils-accurate-lite', 'token-utils-accurate-lite.ts'],
    ] as const) {
      const aliasIndex = config.indexOf(`find: '${specifier}'`);
      expect(aliasIndex).toBeGreaterThanOrEqual(0);
      expect(aliasIndex).toBeLessThan(rootAliasIndex);
      expect(config).toContain(`../../packages/text-splitter/src/${sourcePath}`);
    }
  });

  it('pins file-tree-worker to source so renderer dev does not load stale dist workers', () => {
    const config = readDesktopViteConfig();

    expect(config).toMatch(
      /find:\s*'@brainstrike\/file-tree-worker'[\s\S]*replacement:\s*path\.resolve\(\s*__dirname,\s*'\.\.\/\.\.\/packages\/file-tree-worker\/src\/vite\.ts'\s*\)/
    );
    expect(config).not.toContain('../../packages/file-tree-worker/dist');
    expect(config).toContain("'@brainstrike/file-tree-worker'");
  });

  it('source-aliases context-actions + commands in BOTH renderer vite configs (chunk-init TDZ)', () => {
    // Resolving these to their built `dist` (instead of source, like every other
    // @brainstrike package) lands `defineContextAction` in a separate chunk from
    // the source feature `*/context-actions` that call it at module-init →
    // circular chunk-init TDZ ("t is not a function") that hangs the BUILT
    // renderer on startup forever (dev is unaffected; caught only by live
    // built-app verification / the Desktop E2E smoke). They MUST resolve to src.
    const desktop = readDesktopViteConfig();
    const web = readFileSync(path.resolve(process.cwd(), '../web/vite.config.mts'), 'utf8');
    for (const pkg of ['context-actions', 'commands'] as const) {
      for (const config of [desktop, web]) {
        expect(config).toContain(`@brainstrike/${pkg}`);
        expect(config).toContain(`../../packages/${pkg}/src`);
        // Assert the REAL dist replacement string is absent — `@brainstrike/<pkg>/dist`
        // never appears regardless (aliases are written as `../../packages/<pkg>/<x>`),
        // so that form was a no-op. The path form is the actual regression guard.
        expect(config).not.toContain(`../../packages/${pkg}/dist`);
      }
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
