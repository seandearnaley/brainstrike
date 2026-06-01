import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface PackageMetadata {
  sideEffects?: unknown;
}

describe('@brainstrike/text-splitter package metadata', () => {
  it('marks generated ESM chunks as side-effectful for bundlers', async () => {
    const packageJsonUrl = new URL('../../package.json', import.meta.url);
    const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as PackageMetadata;

    expect(packageJson.sideEffects).toEqual(['dist/chunk-*.js']);
  });
});
