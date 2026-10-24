import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readDesktopViteConfig(): string {
  return readFileSync(path.resolve(process.cwd(), 'vite.config.mts'), 'utf8');
}

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

  it('pins file-tree-worker to source so renderer dev does not load stale dist workers', () => {
    // Deliberate LOCAL override: file-tree-worker's root export is the
    // Node-worker_threads src/index.ts; this app needs the browser-adapted
    // vite.ts implementation instead.
    const config = readDesktopViteConfig();

    expect(config).toMatch(
      /find:\s*'@brainstrike\/file-tree-worker'[\s\S]{0,120}replacement:\s*path\.resolve\(\s*__dirname,\s*'\.\.\/\.\.\/packages\/file-tree-worker\/src\/vite\.ts'\s*\)/
    );
    expect(config).not.toContain('../../packages/file-tree-worker/dist');
  });

  it('aliases @brainstrike/workers subpaths explicitly (no src/ dir)', () => {
    const config = readDesktopViteConfig();

    expect(config).toMatch(/find:\s*'@brainstrike\/workers'/);
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
