import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const readSource = (relativePath: string): string =>
  readFileSync(join(sourceRoot, relativePath), 'utf8');

describe('file-explorer actions architecture', () => {
  it('keeps the executable file-selection action test under the test-file budget', () => {
    const source = readSource('actions/__tests__/file-selection-actions.test.ts');

    expect(source.split('\n').length).toBeLessThanOrEqual(2000);
  });

  it('keeps null-folder early-return behavior in its focused executable spec', () => {
    const source = readSource('actions/__tests__/file-selection-actions-null-folder.test.ts');

    expect(source).toContain('null folderId early returns');
    expect(source.split('\n').length).toBeLessThanOrEqual(2000);
  });
});
