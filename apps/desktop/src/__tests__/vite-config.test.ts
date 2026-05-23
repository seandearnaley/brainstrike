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

  it('pins file-tree-worker to source so renderer dev does not load stale dist workers', () => {
    const config = readDesktopViteConfig();

    expect(config).toMatch(
      /find:\s*'@brainstrike\/file-tree-worker'[\s\S]*replacement:\s*path\.resolve\(\s*__dirname,\s*'\.\.\/\.\.\/packages\/file-tree-worker\/src\/vite\.ts'\s*\)/
    );
    expect(config).not.toContain('../../packages/file-tree-worker/dist');
    expect(config).toContain("'@brainstrike/file-tree-worker'");
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
