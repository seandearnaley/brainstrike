import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import type { ResolvedMcpServer } from '@brainstrike/host-capabilities/mcp/config-file';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';

const stdioServer = {
  args: [],
  command: '/private/mcp-server',
  env: {},
  name: parseConfiguredMcpServerId('local.tools'),
  protocol: 'auto',
  startup: 'automatic',
  transport: 'stdio',
} as const satisfies Extract<ResolvedMcpServer, { transport: 'stdio' }>;

describe('Desktop MCP late stderr classification', () => {
  it('classifies stderr drained during failed-connect cleanup before publishing status', async () => {
    let publishStderr: ((chunk: string) => void) | undefined;
    const client = {
      callTool: vi.fn(async () => ({ content: [] })),
      close: vi.fn(async () => {
        publishStderr?.("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'missing-mcp'\n");
      }),
      complete: vi.fn(async () => ({ completion: { values: [] } })),
      connect: vi.fn(async () => {
        throw new Error('transport closed');
      }),
      getNegotiatedProtocolVersion: vi.fn(() => '2026-07-28'),
      getPrompt: vi.fn(async () => ({ messages: [] })),
      getProtocolEra: vi.fn(() => 'modern' as const),
      getServerCapabilities: vi.fn(() => ({ tools: {} })),
      getServerVersion: vi.fn(() => ({ name: 'test', version: '1.0.0' })),
      listen: vi.fn(),
      listPrompts: vi.fn(async () => ({ prompts: [] })),
      listResources: vi.fn(async () => ({ resources: [] })),
      listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
      listTools: vi.fn(async () => ({ tools: [] })),
      readResource: vi.fn(async () => ({ contents: [] })),
      subscribeResource: vi.fn(async () => undefined),
      unsubscribeResource: vi.fn(async () => undefined),
      watchServerFeatures: vi.fn(() => vi.fn()),
    };
    const runtime = createDesktopMcpHostRuntime({
      createStdioTransportClient: (options) => {
        publishStderr = options.onStderr;
        return client;
      },
    });
    try {
      await runtime.replaceResolvedConfig({
        servers: [{ ...stdioServer, startup: 'authentication-required' }],
      });
      await expect(
        runtime.host.control({
          action: 'connect',
          configuredServerId: stdioServer.name,
        })
      ).rejects.toMatchObject({ code: 'mcp-package-resolution-failed' });

      expect(runtime.host.snapshot().servers[0]).toMatchObject({
        error: {
          category: 'configuration',
          code: 'mcp-package-resolution-failed',
        },
        state: 'error',
      });
    } finally {
      await runtime.host.close();
    }
  });
});
