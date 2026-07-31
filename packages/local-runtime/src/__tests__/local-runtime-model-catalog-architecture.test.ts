import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const catalogFile = fileURLToPath(new URL('../local-runtime-model-catalog.ts', import.meta.url));

describe('local runtime model catalog architecture', () => {
  test('keeps the catalog service file under the source-file budget', () => {
    const lineCount = readFileSync(catalogFile, 'utf8').split('\n').length;

    expect(lineCount).toBeLessThanOrEqual(1500);
  });
});
