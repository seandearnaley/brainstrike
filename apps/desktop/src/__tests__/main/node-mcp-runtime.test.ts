// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExplicitHttpMcpClient } from '@brainstrike/agent/mcp-client';
import { startStatefulMcpHostServer } from '@brainstrike/agent/test-fixtures/mcp-host-lifecycle';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { createSecretsMcpBearerCredentialAuthority } from '../../mcp/bearer-credential';
import { createMcpHostRuntime, type McpHostRuntimePlatform } from '../../mcp/node-host-runtime';
import { createInMemoryMcpOAuthStore } from '../../mcp/oauth-client-provider';

// An accidental desktop construction path must fail even in the desktop test harness.
vi.mock('electron', () => {
  throw new Error('Plain Node MCP authority cannot load Electron');
});

function platform(appUi: McpHostRuntimePlatform['appUi']): McpHostRuntimePlatform {
  return {
    appUi,
    bearerCredentialAuthority: createSecretsMcpBearerCredentialAuthority({
      getKey: async () => null,
      listProviders: async () => [],
    }),
    oauthStore: createInMemoryMcpOAuthStore(),
    openExternal: vi.fn(async () => {
      throw new Error('No browser authorization in this local fixture');
    }),
    openTaskDatabase: vi.fn(async () => {
      throw new Error('This core fixture advertises no Tasks');
    }),
  };
}

describe('configured-server MCP authority with injected Node platform', () => {
  it('fails closed on terminal elicitation when no client can answer the exact request', async () => {
    const injected = platform('text');
    const runtime = createMcpHostRuntime(injected);
    try {
      await expect(
        runtime.elicitationPresenter.presenter.presentForm(
          {
            method: 'elicitation/create',
            params: {
              message: 'Choose the workspace to expose',
              mode: 'form',
              requestedSchema: {
                properties: { workspace: { type: 'string' } },
                required: ['workspace'],
                type: 'object',
              },
            },
          },
          {
            requestId: 'terminal-request',
            serverName: 'node.elicitation',
            signal: new AbortController().signal,
          }
        )
      ).rejects.toMatchObject({ code: 'mcp-elicitation-presenter-unavailable' });
      expect(injected.openExternal).not.toHaveBeenCalled();
    } finally {
      await runtime.host.close();
    }
  });

  it.each(['rich', 'text'] as const)(
    'runs the actual HTTP client with %s Apps capability and complete text results',
    async (appUi) => {
      const server = await startStatefulMcpHostServer();
      const configuredServerId = parseConfiguredMcpServerId('node.http');
      const capabilities: unknown[] = [];
      const injected = platform(appUi);
      const runtime = createMcpHostRuntime(injected, {
        createHttpTransportClient: (options) => {
          capabilities.push(options.extensionRegistry?.toClientExtensionCapabilities());
          return new ExplicitHttpMcpClient(options);
        },
      });
      try {
        await runtime.replaceResolvedConfig({
          servers: [
            {
              name: configuredServerId,
              protocol: 'legacy',
              startup: 'automatic',
              transport: 'streamable-http',
              url: server.url,
            },
          ],
        });
        await expect(
          runtime.host.invoke({ configuredServerId, type: 'tools/list' })
        ).resolves.toMatchObject({
          result: { tools: [expect.objectContaining({ name: 'host_lifecycle_probe' })] },
          type: 'tools/list',
        });
        // A host run's execution capability reaches the presenter's operation authority.
        const runWithOperation = vi.spyOn(runtime.elicitationPresenter, 'runWithOperation');
        const execution = { bindTask: vi.fn(), requestInput: vi.fn() };
        await expect(
          runtime.host.invoke(
            {
              arguments: {},
              configuredServerId,
              toolName: 'host_lifecycle_probe',
              type: 'tools/call',
            },
            { execution }
          )
        ).resolves.toMatchObject({
          result: { content: [{ text: 'ok', type: 'text' }] },
          type: 'tools/call',
        });
        expect(runWithOperation).toHaveBeenLastCalledWith(
          expect.objectContaining({ toolName: 'host_lifecycle_probe', type: 'tools/call' }),
          expect.any(Function),
          execution
        );
        expect(runtime.host.snapshot().servers[0]).toMatchObject({
          extensions: { apps: appUi === 'rich', tasks: true },
          generation: 1,
          state: 'connected',
        });
        expect(capabilities).toEqual([
          {
            'io.modelcontextprotocol/tasks': {},
            ...(appUi === 'rich'
              ? { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } }
              : {}),
          },
        ]);
        await runtime.setMcpExtensionPreferences({ apps: true, tasks: true });
        expect(runtime.host.snapshot().servers[0]?.generation).toBe(1);
        expect(injected.openExternal).not.toHaveBeenCalled();
        expect(injected.openTaskDatabase).not.toHaveBeenCalled();
        expect(await runtime.host.close()).toMatchObject({ clientsClosed: 1, failures: [] });
      } finally {
        await runtime.host.close();
        await server.close();
      }
    }
  );

  it('owns one real stdio client and reaps its child under plain Node composition', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'node-mcp-authority-'));
    const pidFile = path.join(directory, 'pid');
    const stateFile = path.join(directory, 'state.json');
    const configuredServerId = parseConfiguredMcpServerId('node.stdio');
    const runtime = createMcpHostRuntime(platform('text'));
    try {
      await runtime.replaceResolvedConfig({
        servers: [
          {
            args: [
              fileURLToPath(
                import.meta.resolve(
                  '@brainstrike/agent/test-fixtures/mcp-stdio-host-lifecycle-server.mjs'
                )
              ),
            ],
            command: process.execPath,
            env: {
              BRAINSTRIKE_STDIO_TEST_PID_FILE: pidFile,
              BRAINSTRIKE_STDIO_TEST_STATE_FILE: stateFile,
            },
            name: configuredServerId,
            protocol: 'legacy',
            startup: 'automatic',
            transport: 'stdio',
          },
        ],
      });
      await runtime.host.invoke({ configuredServerId, type: 'tools/list' });
      const pid = Number(await readFile(pidFile, 'utf8'));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(await runtime.host.close()).toMatchObject({
        childProcessesClosed: 1,
        clientsClosed: 1,
        failures: [],
      });
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally {
      await runtime.host.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
