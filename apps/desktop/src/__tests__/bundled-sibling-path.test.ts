import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveBundledDistDir, resolveBundledSiblingPath } from '../bundled-sibling-path';

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

  it('rejects an empty module filename instead of guessing from cwd (NO SILENT FALLBACKS)', () => {
    expect(() => resolveBundledSiblingPath('Test context', 'some-worker.js', '')).toThrow(
      'Test context: module.filename unavailable'
    );
  });

  it('falls back to __filename only when no explicit override is given', () => {
    // __filename here is this test file's own real on-disk path — proves
    // the helper resolves a genuine value in the Vitest environment (unlike
    // module.filename, which is a synthetic shim with no .filename there —
    // PR #2680 review), without needing the injectable override.
    expect(() => resolveBundledSiblingPath('Test context', 'some-worker.js')).not.toThrow();
  });
});

describe('resolveBundledDistDir', () => {
  it('returns the dirname of the given module filename', () => {
    expect(resolveBundledDistDir('Test context', '/repo/apps/desktop/dist/main.js')).toBe(
      '/repo/apps/desktop/dist'
    );
  });

  it('rejects an empty module filename instead of guessing from cwd (NO SILENT FALLBACKS)', () => {
    expect(() => resolveBundledDistDir('Test context', '')).toThrow(
      'Test context: module.filename unavailable'
    );
  });
});
