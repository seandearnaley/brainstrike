// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import type * as esbuildTypes from 'esbuild';
import esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../../scripts/build-main-config.mjs';

const desktopRoot = path.resolve(import.meta.dirname, '../../..');
const sourceRoot = path.join(desktopRoot, 'src');

const removedPaths = [
  'src/mcp/http-client.ts',
  'src/mcp/index.ts',
  'src/mcp/sse-client.ts',
  'src/mcp/stdio-client.ts',
  'src/__tests__/fixtures/mcp-stdio-lifecycle-server.mjs',
  'src/__tests__/main/mcp-clients.integration.test.ts',
  'src/__tests__/main/mcp-clients.sse-call.test.ts',
  'src/__tests__/main/mcp-clients.sse.test.ts',
  'src/__tests__/main/mcp-http-client.integration.test.ts',
  'src/__tests__/main/mcp-http-client.test.ts',
  'src/__tests__/main/mcp-index.test.ts',
  'src/__tests__/main/sse-client.test.ts',
  'src/__tests__/main/stdio-client.test.ts',
] as const;

const forbiddenProductionPatterns = [
  /\bdisposeClients\b/u,
  /\binitClients\b/u,
  /\bcreateHttpClient\b/u,
  /\bcreateSseClient\b/u,
  /\bcreateStdioClient\b/u,
  /\bMcpClient\b/u,
  /\bDEFAULT_STDIO_CONNECT_TIMEOUT_MS\b/u,
  /\bMCP_STDIO_CONNECT_TIMEOUT_MS\b/u,
] as const;

function readProductionSources(directory: string): Array<{ path: string; source: string }> {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : readProductionSources(absolutePath);
    }
    if (!(entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      return [];
    }
    return [
      {
        path: path.relative(desktopRoot, absolutePath),
        source: fs.readFileSync(absolutePath, 'utf8'),
      },
    ];
  });
}

describe('legacy desktop MCP client removal contract', () => {
  it('keeps the dormant registry, factories, fixture, and their tests deleted', () => {
    expect(
      removedPaths.filter((relativePath) => fs.existsSync(path.join(desktopRoot, relativePath)))
    ).toEqual([]);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const packageName of [
      '@modelcontextprotocol/node',
      '@modelcontextprotocol/server',
      '@modelcontextprotocol/server-filesystem',
      '@modelcontextprotocol/server-legacy',
    ]) {
      expect(declared[packageName]).toBeUndefined();
    }
  });

  it('forbids legacy registry, factory, client, and fixed-deadline symbols in production source', () => {
    const violations = readProductionSources(sourceRoot).flatMap(({ path: relativePath, source }) =>
      forbiddenProductionPatterns
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relativePath}: ${pattern.source}`)
    );

    expect(violations).toEqual([]);
  });

  it('preserves the shared status and discovered-tool helpers', () => {
    const source = fs.readFileSync(path.join(sourceRoot, 'mcp/types.ts'), 'utf8');
    const providerContract = fs.readFileSync(
      path.resolve(desktopRoot, '../../docs/agents/assistant-providers.md'),
      'utf8'
    );

    expect(source).toContain('export interface McpDiscoveredTool');
    expect(source).toContain('export function connectedStatus');
    expect(source).toContain('export function mcpStatusErrorMessage');
    expect(providerContract).toMatch(
      /The dormant\s+pre-host global client registry, desktop `McpClient` wrapper, and HTTP\/stdio\/SSE\s+factory adapters do not exist\./u
    );
  });

  it('omits the legacy stack from the production Electron main bundle', async () => {
    const buildOptions: esbuildTypes.BuildOptions = {
      ...(MAIN_PROCESS_BUILD_OPTIONS as Omit<esbuildTypes.BuildOptions, 'entryPoints'>),
      absWorkingDir: desktopRoot,
      entryPoints: { main: path.join(sourceRoot, 'main-bootstrap.ts') },
      logLevel: 'silent',
      write: false,
    };
    const result = await esbuild.build(buildOptions);
    const mainOutput = result.outputFiles?.find(
      (output) => path.basename(output.path) === 'main.js'
    );
    if (!mainOutput) {
      throw new Error('Production MCP removal verifier did not receive the Electron main bundle');
    }
    const bundle = mainOutput.text;
    expect(bundle).toContain('Ready-dependent IPC handlers registered successfully');

    for (const marker of [
      'src/mcp/http-client.ts',
      'src/mcp/index.ts',
      'src/mcp/sse-client.ts',
      'src/mcp/stdio-client.ts',
      'DesktopStdioMcpClient',
      'MCP_STDIO_CONNECT_TIMEOUT_MS',
      'disposeClients',
    ]) {
      expect(bundle, `unexpected legacy MCP marker in production bundle: ${marker}`).not.toContain(
        marker
      );
    }
  });
});
