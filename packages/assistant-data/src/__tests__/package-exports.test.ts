import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('@brainstrike/assistant-data package contract', () => {
  it('publishes the required export subpaths', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };

    expect(Object.keys(manifest.exports).sort()).toEqual(
      [
        '.',
        './assistant-memory-repository',
        './assistant-thread-run-reaper',
        './cost-tracking',
      ].sort()
    );
  });

  it('has source entry points for every code export', () => {
    expect(existsSync(join(packageRoot, 'src/index.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'src/assistant-thread-run-reaper.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'src/assistant-memory-repository.ts'))).toBe(true);
    expect(existsSync(join(packageRoot, 'src/cost-tracking/index.ts'))).toBe(true);
  });
});
