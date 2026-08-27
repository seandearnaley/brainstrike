import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveBundledModuleDir, resolveBundledSiblingPath } from '../bundled-sibling-path';

describe('resolveBundledSiblingPath', () => {
  it('joins the given file name onto the dist/ directory of the current module', () => {
    expect(
      resolveBundledSiblingPath('Test context', 'some-worker.js', '/repo/apps/desktop/dist/main.js')
    ).toBe(path.join('/repo/apps/desktop/dist', 'some-worker.js'));
  });

  it('tracks a differently-shaped module path instead of a fixed string', () => {
    expect(resolveBundledSiblingPath('Test context', 'some-worker.js', '/a/b/c/dist/main.js')).toBe(
      path.join('/a/b/c/dist', 'some-worker.js')
    );
  });

  it('rejects an empty __filename instead of guessing from cwd (NO SILENT FALLBACKS)', () => {
    expect(() => resolveBundledSiblingPath('Test context', 'some-worker.js', '')).toThrow(
      'Test context: __filename unavailable'
    );
  });

  it('falls back to __filename only when no explicit override is given', () => {
    // The __filename this exercises belongs to bundled-sibling-path.ts (the
    // helper module itself, where the bare __filename reference lives), not
    // to this test file — it's this file's SOURCE-file path under Vitest
    // rather than dist/main.js, but a genuine non-empty value either way.
    // Proves the helper resolves something real in the Vitest environment
    // (unlike module.filename, a synthetic shim with no .filename there —
    // PR #2680 review), without needing the injectable override.
    expect(() => resolveBundledSiblingPath('Test context', 'some-worker.js')).not.toThrow();
  });
});

describe('resolveBundledModuleDir', () => {
  it('returns the dirname of the given module filename', () => {
    expect(resolveBundledModuleDir('Test context', '/repo/apps/desktop/dist/main.js')).toBe(
      '/repo/apps/desktop/dist'
    );
  });

  it('rejects an empty __filename instead of guessing from cwd (NO SILENT FALLBACKS)', () => {
    expect(() => resolveBundledModuleDir('Test context', '')).toThrow(
      'Test context: __filename unavailable'
    );
  });
});
