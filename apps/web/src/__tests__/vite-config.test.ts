import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readWebViteConfig(): string {
  return readFileSync(path.resolve(process.cwd(), 'vite.config.mts'), 'utf8');
}

describe('web vite config alias contract', () => {
  it('pins token-cache runtime imports to source entries', () => {
    const config = readWebViteConfig();

    expect(config).toContain("'@brainstrike/token-cache/cache-runtime': path.resolve(");
    expect(config).toContain('../../packages/token-cache/src/cache-runtime.ts');
    expect(config).toContain("'@brainstrike/token-cache/background-indexer': path.resolve(");
    expect(config).toContain('../../packages/token-cache/src/background-indexer.ts');
  });

  it('pins selection-rules to the workspace source entry', () => {
    const config = readWebViteConfig();

    expect(config).toContain("'@brainstrike/selection-rules': path.resolve(");
    expect(config).toContain('../../packages/selection-rules/src/index.ts');
  });

  it('pins file-tree-worker to source so renderer dev does not load stale dist workers', () => {
    const config = readWebViteConfig();

    expect(config).toContain("'@brainstrike/file-tree-worker': path.resolve(");
    expect(config).toContain('../../packages/file-tree-worker/src/vite.ts');
    expect(config).toContain("'@brainstrike/file-tree-worker'");
  });
});
