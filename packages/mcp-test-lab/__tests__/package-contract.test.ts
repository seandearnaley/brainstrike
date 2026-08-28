import { readdir, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  exports: Record<string, { default: string; types: string }>;
  files: string[];
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
    expect(manifest.files).toEqual(['dist', 'fixtures']);
    expect(manifest.types).toBe('./dist/index.d.ts');
    expect(manifest.exports).toEqual({
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
      './evidence': { default: './dist/evidence.js', types: './dist/evidence.d.ts' },
      './faults': { default: './dist/faults.js', types: './dist/faults.d.ts' },
      './lab': { default: './dist/lab.js', types: './dist/lab.d.ts' },
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

  it('keeps the living provider contract aligned with ownership and evidence integrity', async () => {
    const contract = await readFile(
      new URL('../../../docs/agents/assistant-providers.md', import.meta.url),
      'utf8'
    );

    expect(contract).toContain('@brainstrike/mcp-test-lab');
    expect(contract).toContain('lab-owned `StdioClientTransport`');
    expect(contract).toContain('SHA-256 digest over the original bytes');
    expect(contract).toContain('`node/dispatch` coordinate');
  });
});
