import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface PackageMetadata {
  sideEffects?: unknown;
}

function getRelativeRuntimeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromClausePattern = /\b(?:import|export)\b[\s\S]*?\bfrom\s+['"](\.[^'"]+)['"]/g;

  for (const match of source.matchAll(fromClausePattern)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }

  return specifiers;
}

describe('@brainstrike/text-splitter package metadata', () => {
  it('marks generated ESM chunks as side-effectful for bundlers', async () => {
    const packageJsonUrl = new URL('../../package.json', import.meta.url);
    const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as PackageMetadata;

    expect(packageJson.sideEffects).toEqual(['dist/chunk-*.js']);
  });

  it('keeps package entrypoint relative imports valid for Node ESM', async () => {
    const indexSourceUrl = new URL('../index.ts', import.meta.url);
    const indexSource = await readFile(indexSourceUrl, 'utf8');
    const extensionlessSpecifiers = getRelativeRuntimeSpecifiers(indexSource).filter(
      (specifier) => !specifier.endsWith('.js')
    );

    expect(extensionlessSpecifiers).toEqual([]);
  });
});
