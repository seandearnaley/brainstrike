import {
  type McpHostOperation,
  type McpHostOperationResult,
  type McpHostPort,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { McpContentService } from '../src/mcp/content-service.js';
import { McpHostRevisionPublisher } from '../src/mcp/host-revision-publisher.js';

const SERVER_ID = parseConfiguredMcpServerId('reference');
const URI = 'echo://reference';
const RESOURCE = {
  contents: [{ mimeType: 'text/plain', text: 'Reference body.', uri: URI }],
} as const;

/** The runtime's own revision publisher, with one connected server, and its invoke. */
function createHost(invoke = vi.fn(async (_operation: McpHostOperation) => resourceResult())) {
  const publisher = new McpHostRevisionPublisher({
    onDiagnostic: (_diagnostic, cause) => {
      throw cause;
    },
  });
  publisher.publishConfigSet([
    {
      catalog: {
        errors: {},
        features: {
          completion: true,
          promptListChanged: false,
          prompts: true,
          resourceListChanged: false,
          resourceSubscriptions: false,
          resources: true,
          toolListChanged: false,
          tools: true,
        },
        subscription: { mode: 'none', state: 'closed' },
      },
      configuredProtocol: 'legacy',
      configuredServerId: SERVER_ID,
      generation: 2,
      negotiated: { era: 'legacy', revision: '2025-06-18' },
      state: 'connected',
      transport: 'streamable-http',
    },
  ]);
  const host: Pick<McpHostPort, 'invoke' | 'snapshot' | 'watch'> = {
    invoke: invoke as unknown as McpHostPort['invoke'],
    snapshot: () => publisher.snapshot(),
    watch: publisher.watch.bind(publisher),
  };
  return { host, invoke };
}

function resourceResult(): McpHostOperationResult {
  return { result: RESOURCE, type: 'resources/read' };
}

describe('MCP content service (BST-1930 c5d)', () => {
  it("reads one connected generation's resource through the content port", async () => {
    const { host, invoke } = createHost();
    const service = new McpContentService({ admit: async () => true, host });

    await expect(
      service.read({ authority: { configuredServerId: 'reference', generation: 2 }, uri: URI })
    ).resolves.toEqual({ ok: true, result: resourceResult() });
    expect(invoke).toHaveBeenCalledWith(
      { configuredServerId: SERVER_ID, type: 'resources/read', uri: URI },
      expect.anything()
    );
  });

  it('refuses while the settings lifecycle is closed, before reaching the server', async () => {
    const { host, invoke } = createHost();
    const service = new McpContentService({ admit: async () => false, host });

    await expect(
      service.prompt({ authority: { configuredServerId: 'reference', generation: 2 }, name: 'x' })
    ).resolves.toEqual({
      error: {
        category: 'not-connected',
        code: 'mcp_content_lifecycle_closed',
        message: 'MCP lifecycle is closed for cleanup',
      },
      ok: false,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('answers in the content taxonomy, never with a server or cause text', async () => {
    const leaky = vi.fn(async () => {
      throw new Error('server stack trace with /abs/path and a token');
    });
    const { host } = createHost(leaky);
    const service = new McpContentService({ admit: async () => true, host });
    const authority = { configuredServerId: 'reference', generation: 2 };

    const stale = await service.read({ authority: { ...authority, generation: 1 }, uri: URI });
    expect(stale).toEqual({
      error: {
        category: 'generation-retired',
        code: 'mcp_content_generation_retired',
        message: 'MCP content generation retired',
      },
      ok: false,
    });
    const invalid = await service.read({
      authority: { ...authority, configuredServerId: ' x' },
      uri: URI,
    });
    expect(invalid).toMatchObject({ error: { code: 'mcp_content_request_invalid' }, ok: false });
    const failed = await service.read({ authority, uri: URI });
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain('/abs/path');
  });
});
