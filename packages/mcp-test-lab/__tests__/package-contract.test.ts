import { readdir, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports: Record<string, { default: string; types: string }>;
  files: string[];
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts: Record<string, string>;
  types: string;
}

async function readManifest(): Promise<PackageManifest> {
  const text = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  return JSON.parse(text) as PackageManifest;
}

describe('MCP test lab package contract', () => {
  it('emits every public entry as Node-compatible JavaScript plus declarations', async () => {
    const manifest = await readManifest();

    expect(manifest.scripts['build']).toBe(
      'node ../../scripts/prune-stale-dist.mjs && tsc -b . && node scripts/verify-built-package.mjs'
    );
    expect(manifest.scripts['test:integration']).toBeUndefined();
    expect(manifest.files).toEqual(['dist']);
    expect(manifest.types).toBe('./dist/index.d.ts');
    expect(manifest.exports).toEqual({
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
      './scenario': { default: './dist/scenario.js', types: './dist/scenario.d.ts' },
    });
  });

  it('uses NodeNext-compatible extensions for every relative source import and export', async () => {
    const sourceDirectory = new URL('../src/', import.meta.url);
    const sourceFiles = (await readdir(sourceDirectory)).filter((name) => extname(name) === '.ts');
    const invalid: string[] = [];

    for (const sourceFile of sourceFiles) {
      const text = await readFile(new URL(sourceFile, sourceDirectory), 'utf8');
      for (const match of text.matchAll(/(?:from|export\s+\*)\s+['"](\.[^'"]+)['"]/gu)) {
        const specifier = match[1];
        if (specifier && !specifier.endsWith('.js')) {
          invalid.push(`${sourceFile}: ${specifier}`);
        }
      }
    }

    expect(invalid).toEqual([]);
  });

  it('stays absent from every other workspace package dependency graph', async () => {
    const repositoryRoot = new URL('../../../', import.meta.url);
    const offenders: string[] = [];

    for (const workspaceRoot of ['apps', 'packages']) {
      const directories = await readdir(new URL(`${workspaceRoot}/`, repositoryRoot), {
        withFileTypes: true,
      });
      for (const directory of directories) {
        if (!(directory.isDirectory() && directory.name !== 'mcp-test-lab')) {
          continue;
        }
        const manifestUrl = new URL(
          `${workspaceRoot}/${directory.name}/package.json`,
          repositoryRoot
        );
        let manifest: PackageManifest;
        try {
          manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as PackageManifest;
        } catch (error: unknown) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            continue;
          }
          throw error;
        }
        const dependencyGroups = [
          manifest.dependencies,
          manifest.devDependencies,
          manifest.optionalDependencies,
          manifest.peerDependencies,
        ];
        if (dependencyGroups.some((group) => group?.['@brainstrike/mcp-test-lab'] !== undefined)) {
          offenders.push(manifest.name ?? `${workspaceRoot}/${directory.name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
