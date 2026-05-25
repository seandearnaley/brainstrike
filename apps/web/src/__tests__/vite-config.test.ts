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

  it('pins text-splitter subpath imports before the root source alias', () => {
    const config = readWebViteConfig();
    const rootAliasIndex = config.indexOf("'@brainstrike/text-splitter': path.resolve(");

    for (const [specifier, sourcePath] of [
      ['@brainstrike/text-splitter/chunking-core', 'chunking-core.ts'],
      ['@brainstrike/text-splitter/token-counting-heuristics', 'token-counting-heuristics.ts'],
      ['@brainstrike/text-splitter/token-constants', 'token-constants.ts'],
      ['@brainstrike/text-splitter/token-utils-accurate-lite', 'token-utils-accurate-lite.ts'],
    ] as const) {
      const aliasIndex = config.indexOf(`'${specifier}': path.resolve(`);
      expect(aliasIndex).toBeGreaterThanOrEqual(0);
      expect(aliasIndex).toBeLessThan(rootAliasIndex);
      expect(config).toContain(`../../packages/text-splitter/src/${sourcePath}`);
    }
  });

  it('pins file-tree-worker to source so renderer dev does not load stale dist workers', () => {
    const config = readWebViteConfig();

    expect(config).toMatch(
      /'@brainstrike\/file-tree-worker':\s*path\.resolve\(\s*__dirname,\s*'\.\.\/\.\.\/packages\/file-tree-worker\/src\/vite\.ts'\s*\)/
    );
    expect(config).not.toContain('../../packages/file-tree-worker/dist');
    expect(config).toContain("'@brainstrike/file-tree-worker'");
  });
});
