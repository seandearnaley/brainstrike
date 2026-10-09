// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import {
  connectedStatus,
  type McpDiscoveredTool,
  mcpStatusErrorMessage,
} from '@brainstrike/host-capabilities/mcp/types';
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
    // The helpers moved with the Node MCP host (host-capabilities); their behaviour is the contract.
    const tool: McpDiscoveredTool = { description: 'Create an issue', inputSchema: {} };
    expect(tool.description).toBe('Create an issue');
    const base = {
      configuredProtocol: 'auto',
      name: 'linear',
      transport: 'streamable-http',
    } as const;
    const facts = (era: 'modern' | undefined) => ({
      getNegotiatedProtocolVersion: () => (era ? '2026-07-28' : undefined),
      getProtocolEra: () => era,
      getServerCapabilities: () => ({ resources: {}, tools: {} }),
      getServerVersion: () => ({ name: 'linear-fixture', version: '1.0.0' }),
    });
    expect(connectedStatus(facts('modern'), base)).toEqual({
      ...base,
      negotiated: {
        advertisedCapabilityIds: ['resources', 'tools'],
        era: 'modern',
        revision: '2026-07-28',
        serverIdentity: { name: 'linear-fixture', version: '1.0.0' },
      },
      state: 'connected',
    });
    expect(connectedStatus(facts(undefined), base)).toEqual({
      ...base,
      error: 'Connected MCP client has no negotiated protocol facts',
      state: 'error',
    });
    expect(mcpStatusErrorMessage({ status: 401 })).toBe('MCP connection failed (HTTP 401)');
    expect(mcpStatusErrorMessage(new Error('socket hang up'))).toBe('MCP connection failed');
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
