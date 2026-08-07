import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('@brainstrike/assistant-ui package contract', () => {
  it('publishes the four required export subpaths', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };

    expect(Object.keys(manifest.exports).sort()).toEqual(
      ['.', './context-usage-store', './follow-up-queue-store', './rewind-composer-store'].sort()
    );
  });

  it('has a source root entry point', () => {
    expect(existsSync(join(packageRoot, 'src/index.ts'))).toBe(true);
  });
});
