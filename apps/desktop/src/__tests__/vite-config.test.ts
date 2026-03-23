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
});
