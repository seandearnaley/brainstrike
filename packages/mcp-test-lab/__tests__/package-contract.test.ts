import { readdir, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import ts from 'typescript';
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

interface TypeScriptConfig {
  compilerOptions?: Record<string, unknown>;
}

async function readManifest(): Promise<PackageManifest> {
  const text = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  return JSON.parse(text) as PackageManifest;
}

async function readTypeScriptConfig(url: URL): Promise<TypeScriptConfig> {
  const result = ts.parseConfigFileTextToJson(url.pathname, await readFile(url, 'utf8'));
  if (result.error) {
    throw new Error('Could not parse TypeScript config');
  }
  return result.config as TypeScriptConfig;
}

describe('MCP test lab package contract', () => {
  it('emits every public entry as Node-compatible JavaScript plus declarations', async () => {
    const manifest = await readManifest();

    expect(manifest.scripts['build']).toContain('tsc -b .');
    expect(manifest.scripts['build']).toContain('node scripts/verify-built-package.mjs');
    expect(manifest.scripts['test:integration']).toBe(
      'vitest run --config vitest.integration.config.mts'
    );
    // The verifier consumes the Tasks contract's built declarations, and the
    // lab's own `tsc -b` has no project references, so a fresh checkout must
    // build that workspace dependency first (the scheduled exhaustive job only
    // installs before `verify:mcp`).
    expect(manifest.scripts['verify']).toBe(
      'pnpm --filter @brainstrike/mcp-tasks-extension build && pnpm run build && node dist/runner-cli.js'
    );
    expect(manifest.files).toEqual(['dist', 'fixtures']);
    expect(manifest.types).toBe('./dist/index.d.ts');
    expect(manifest.exports).toEqual({
      '.': { default: './dist/index.js', types: './dist/index.d.ts' },
      './evidence': { default: './dist/evidence.js', types: './dist/evidence.d.ts' },
      './faults': { default: './dist/faults.js', types: './dist/faults.d.ts' },
      './lab': { default: './dist/lab.js', types: './dist/lab.d.ts' },
      './runner': { default: './dist/runner.js', types: './dist/runner.d.ts' },
      './scenario': { default: './dist/scenario.js', types: './dist/scenario.d.ts' },
    });
  });

  it('keeps test type-checking isolated from build incremental state', async () => {
    const config = await readTypeScriptConfig(new URL('../tsconfig.test.json', import.meta.url));

    expect(config.compilerOptions).toMatchObject({
      composite: false,
      declaration: false,
      declarationMap: false,
      incremental: false,
      noEmit: true,
    });
  });

  it('separates executable runtime dependencies from test-only conformance', async () => {
    const manifest = await readManifest();

    expect(manifest.dependencies).toEqual({
      '@brainstrike/mcp-tasks-extension': 'workspace:*',
      '@modelcontextprotocol/client': 'catalog:',
      '@modelcontextprotocol/node': 'catalog:',
      '@modelcontextprotocol/server': 'catalog:',
      entities: '8.0.0',
      zod: 'catalog:',
    });
    expect(manifest.devDependencies).toMatchObject({
      '@modelcontextprotocol/conformance': '0.2.0-alpha.12',
    });
  });

  it('cannot be imported through root TypeScript paths or shared source aliases', async () => {
    const repositoryRoot = new URL('../../../', import.meta.url);
    const rootConfig = await readTypeScriptConfig(new URL('tsconfig.json', repositoryRoot));
    const aliasModule: unknown = await import(
      new URL('packages/test-utils/workspace-src-aliases.mjs', repositoryRoot).href
    );
    if (
      typeof aliasModule !== 'object' ||
      aliasModule === null ||
      !('workspaceSrcAliases' in aliasModule) ||
      typeof aliasModule.workspaceSrcAliases !== 'function'
    ) {
      throw new Error('Workspace source alias registry has no callable export');
    }
    const aliases: readonly { readonly replacement: string }[] = aliasModule.workspaceSrcAliases(
      new URL('packages/', repositoryRoot).pathname
    );

    const paths = rootConfig.compilerOptions?.['paths'] as Record<string, unknown> | undefined;
    expect(paths?.['@brainstrike/mcp-test-lab']).toBeUndefined();
    expect(aliases.some(({ replacement }) => replacement.includes('/mcp-test-lab/src/'))).toBe(
      false
    );
  });

  it('uses NodeNext-compatible extensions for every relative source import and export', async () => {
    const sourceDirectory = new URL('../src/', import.meta.url);
    const sourceFiles = (await readdir(sourceDirectory, { recursive: true })).filter(
      (name) => extname(name) === '.ts'
    );
    const invalid: string[] = [];

    for (const sourceFile of sourceFiles) {
      const text = await readFile(new URL(sourceFile, sourceDirectory), 'utf8');
      for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/gu)) {
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
    const manifestUrls = [new URL('package.json', repositoryRoot)];

    for (const workspaceRoot of ['apps', 'packages', 'packages/config']) {
      const directories = await readdir(new URL(`${workspaceRoot}/`, repositoryRoot), {
        withFileTypes: true,
      });
      for (const directory of directories) {
        if (!(directory.isDirectory() && directory.name !== 'mcp-test-lab')) {
          continue;
        }
        manifestUrls.push(
          new URL(`${workspaceRoot}/${directory.name}/package.json`, repositoryRoot)
        );
      }
    }
    for (const manifestUrl of manifestUrls) {
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
        offenders.push(manifest.name ?? manifestUrl.pathname);
      }
    }

    expect(offenders).toEqual([]);
  });
});
