import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('@brainstrike/assistant-ui package contract', () => {
  it('publishes the required export subpaths', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };

    expect(Object.keys(manifest.exports).sort()).toEqual(
      [
        '.',
        './context-usage-store',
        './follow-up-queue-store',
        './mcp-task-bridge-context',
        './mcp-task-status-card',
        './rewind-composer-store',
        // Tailwind source directive, imported by both app stylesheets.
        './styles.css',
      ].sort()
    );
  });

  it('has a source root entry point', () => {
    expect(existsSync(join(packageRoot, 'src/index.ts'))).toBe(true);
  });
});
