import { readdir, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { getMcpLabScenario, MCP_LAB_SCENARIO_IDS } from '../src/scenario';

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
      '@modelcontextprotocol/conformance': '0.2.0-alpha.10',
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

  it('keeps the living provider contract authoritative for the MCP 2026 host architecture', async () => {
    // BST-1590 split the living contract: host architecture stays in
    // assistant-providers.md; the verifier harness, official conformance
    // client/driver, and evidence prose live in mcp-conformance.md. The
    // expectations below span both, so read them together.
    const providerContract = await readFile(
      new URL('../../../docs/agents/assistant-providers.md', import.meta.url),
      'utf8'
    );
    const conformanceContract = await readFile(
      new URL('../../../docs/agents/mcp-conformance.md', import.meta.url),
      'utf8'
    );
    const contract = `${providerContract}\n${conformanceContract}`;
    const normalizedContract = contract.replace(/\s+/gu, ' ');
    const research = await readFile(
      new URL(
        '../../../docs/agents/research/bst-1478-mcp-v2-oauth-architecture-spike.md',
        import.meta.url
      ),
      'utf8'
    );
    const manifest = await readManifest();
    const publicSubpaths = Object.keys(manifest.exports).filter((key) => key !== '.');
    const executableScenarioIds = MCP_LAB_SCENARIO_IDS.filter(
      (id) => getMcpLabScenario(id).availability === 'executable'
    );

    expect(normalizedContract).toContain('`@brainstrike/mcp-test-lab`');
    expect(normalizedContract).toContain('production-independent verifier');
    expect(executableScenarioIds).toEqual([
      'modern-reference',
      'legacy-reference',
      'stdio-reference',
      'oauth-reference',
      'tasks-reference',
      'apps-reference',
    ]);
    expect(normalizedContract).toContain(
      "`modern-reference` and `legacy-reference` have `availability: 'executable'`"
    );
    expect(normalizedContract).toContain(
      '`oauth-reference` is executable only over an ephemeral loopback listener'
    );
    expect(normalizedContract).toContain('private artifact-integrity core reads each unique');
    expect(normalizedContract).toContain('explicit positive byte limit');
    expect(normalizedContract).toContain('sanitizes schema metadata and every extracted artifact');
    expect(normalizedContract).toContain('bounded HTML-entity and structured JSON decoding');
    expect(normalizedContract).toContain(
      'Evidence schema `1.1.0` makes desktop applicability explicit'
    );
    expect(normalizedContract).toContain('prescribed Settings/OAuth/assistant');
    expect(normalizedContract).toContain('source-backed profile of the official SDK v2');
    expect(normalizedContract).toContain('A package export may appear only in');
    expect(normalizedContract).toContain(
      `Current public verifier subpaths: ${publicSubpaths.map((key) => `\`${key}\``).join(', ')}.`
    );
    expect(normalizedContract).toContain(
      '`McpHostService` is the sole production SDK client owner'
    );
    expect(normalizedContract).toContain(
      'Every actor validates negotiated status, operation results, and close reports'
    );
    expect(normalizedContract).toContain('Public actor close is idempotent and never rejects.');
    expect(normalizedContract).toContain(
      'Raw internal causes reach one required main-process diagnostic sink'
    );
    expect(normalizedContract).toContain('The exact frozen aggregate then latches the host');
    expect(normalizedContract).toContain(
      'A config publication failure closes every provisional actor'
    );
    expect(normalizedContract).toContain(
      'Terminal `close` aggregates that ledger with all actors current at shutdown'
    );
    expect(normalizedContract).toContain(
      '`ExplicitHttpMcpClient` defaults to `client-owned` lifecycle'
    );
    expect(normalizedContract).toContain(
      '`ExplicitStdioMcpClient` publishes pending child ownership before connection begins'
    );
    expect(normalizedContract).toContain(
      'The host publisher alone owns a monotonic revision sequence beginning at zero.'
    );
    expect(normalizedContract).toContain('Empty configured-server-id filters are rejected visibly');
    expect(normalizedContract).toContain(
      'Actor transitions must exactly match the config-owned generation, protocol policy, and transport.'
    );
    expect(normalizedContract).toContain(
      'The queued event and returned snapshot are separate detached values.'
    );
    expect(normalizedContract).toContain(
      'Terminal host close invalidates queued and future watch registrations'
    );
    expect(normalizedContract).toContain('includes their exact count in the frozen close proof');
    expect(normalizedContract).toContain(
      'normal teardown cannot create false listener-failure diagnostics'
    );
    expect(normalizedContract).toContain(
      '`McpHostPort` exposes exactly `snapshot`, `invoke`, `watch`, `replaceConfig`, `control`, and `close`'
    );
    expect(normalizedContract).toContain('dedicated encrypted MCP credential store');
    expect(normalizedContract).toContain('`@modelcontextprotocol/client@2.1.0`');
    expect(normalizedContract).toContain('share Zod 4.6.5');
    expect(normalizedContract).toContain('`cc4b41617ce3601b1290d67216ea0b194a3cd9ac`');
    expect(normalizedContract).toContain('`2026-07-28`');
    expect(research).toContain('Status: historical research evidence; decisions promoted to');
    expect(research).toContain(
      '[living provider contract](../assistant-providers.md#mcp-2026-host-architecture)'
    );
    expect(contract).toContain('exports `./faults` only after');
    expect(contract).toContain('HTTP fault execution is private package machinery');
    expect(normalizedContract).toContain('Only the private claimed capability may consume faults');
    expect(normalizedContract).toContain(
      'single-session and permanent even when later startup fails'
    );
    expect(normalizedContract).toContain(
      'One private cleanup owner serially closes every session resource'
    );
    expect(normalizedContract).toContain('concurrent callers share that attempt');
    expect(normalizedContract).toContain(
      'Spawn failure therefore leaves stderr and exit untriggered'
    );
    expect(normalizedContract).toContain('verifier proves the captured PID reaches `ESRCH`');
    expect(normalizedContract).toContain('Stdio protocol sends are serialized in invocation order');
    expect(normalizedContract).toContain('distinguishing numeric `1` from string `"1"`');
    expect(contract).toContain('bounds and snapshots declaration');
    expect(contract).toContain('@modelcontextprotocol/core@2.0.0');
    expect(contract).toContain('`assertScenarioFaultCompatibility`');
    expect(normalizedContract).toContain(
      "pinned SDK's `classifyInboundRequest` and `specTypeSchemas`"
    );
    expect(normalizedContract).toContain('Occurrences are independent per exact phase/method');
    expect(normalizedContract).toContain(
      'after bearer authentication and bounded body preparation'
    );
    expect(normalizedContract).toContain('destroys the socket before status bytes are written');
    expect(normalizedContract).toContain('response-stage replacements cancel the displaced body');
    expect(normalizedContract).toContain('diagnostics are capped at 64 per session');
    expect(normalizedContract).toContain('Session close waits for active fault delays');
  });
});
