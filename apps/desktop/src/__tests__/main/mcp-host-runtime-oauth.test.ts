import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopMcpHostRuntime } from '../../mcp/host-runtime';
import {
  createInMemoryMcpOAuthStore,
  createMcpOAuthClientProvider,
  type McpOAuthClientProvider,
} from '../../mcp/oauth-client-provider';
import type { ResolvedMcpServer } from '../../mcp-loader';

let runtime: ReturnType<typeof createDesktopMcpHostRuntime> | undefined;

const oauthServer = {
  auth: { type: 'oauth-user' },
  name: parseConfiguredMcpServerId('team.linear.prod'),
  protocol: 'auto',
  startup: 'authentication-required',
  transport: 'streamable-http',
  url: 'https://linear.example/mcp',
} satisfies ResolvedMcpServer;

function failingTransportClient() {
  return {
    callTool: vi.fn(async () => ({ content: [] })),
    close: vi.fn(async () => {
      throw new Error('client cleanup failed');
    }),
    complete: vi.fn(async () => ({ completion: { values: [] } })),
    connect: vi.fn(async () => {
      throw new Error('connect failed');
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
}

afterEach(async () => {
  await runtime?.host.close();
  runtime = undefined;
  vi.restoreAllMocks();
});

describe('DesktopMcpHostRuntime OAuth cleanup', () => {
  it('preserves the connection failure with client and provider cleanup failures', async () => {
    let provider: McpOAuthClientProvider | undefined;
    const onInternalError = vi.fn();
    runtime = createDesktopMcpHostRuntime({
      createHttpTransportClient: failingTransportClient,
      createOAuthProvider: async (options) => {
        provider = await createMcpOAuthClientProvider(options);
        const close = provider.close.bind(provider);
        vi.spyOn(provider, 'close').mockImplementation(async () => {
          await close();
          throw new Error('provider cleanup failed');
        });
        return provider;
      },
      oauthStore: createInMemoryMcpOAuthStore(),
      onInternalError,
      openExternal: vi.fn(async () => undefined),
    });
    await runtime.replaceResolvedConfig({ servers: [oauthServer] });

    await expect(
      runtime.host.control({ action: 'connect', configuredServerId: oauthServer.name })
    ).rejects.toMatchObject({ code: 'mcp-client-creation-failed' });
    const diagnostic = onInternalError.mock.calls.find(
      ([code]) => code === 'mcp-client-creation-failed'
    );
    expect(diagnostic?.[1]).toMatchObject({
      errors: [
        { cause: { message: 'connect failed' } },
        {
          errors: [{ message: 'client cleanup failed' }, { message: 'provider cleanup failed' }],
        },
      ],
    });
    expect(provider?.close).toHaveBeenCalledOnce();
    await runtime.host.close();
  });
});
