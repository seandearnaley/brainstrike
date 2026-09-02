import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createReferenceServer } from '../src/reference-server';

function fetchThrough(handler: McpHttpHandler): typeof fetch {
  return async (input, init) => handler.fetch(new Request(input, init));
}

async function connectClient(
  handler: McpHttpHandler,
  era: 'legacy' | 'modern',
  answer: (message: string) => {
    action: 'accept' | 'decline';
    content?: Record<string, boolean | number | string | string[]>;
  }
) {
  const elicitations: string[] = [];
  const client = new Client(
    { name: 'brainstrike-reference-elicitation-test', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      inputRequired: { autoFulfill: true, maxRounds: 2 },
      versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } },
    }
  );
  client.setRequestHandler('elicitation/create', async (request) => {
    elicitations.push(request.params.message);
    return answer(request.params.message);
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://mcp-lab.invalid/mcp'), {
      fetch: fetchThrough(handler),
    })
  );
  return { client, elicitations };
}

describe('brainstrike echo reference elicit_confirm', () => {
  it('elicits confirmation through the modern multi-round-trip flow and echoes only after accept', async () => {
    const handler = createMcpHandler(() => createReferenceServer('brainstrike-sdk-v2-reference'), {
      legacy: 'reject',
    });
    const accepted = await connectClient(handler, 'modern', () => ({
      action: 'accept',
      content: { confirm: true, note: 'from test' },
    }));
    try {
      expect(accepted.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      await expect(
        accepted.client.callTool({ arguments: { text: 'echo-me' }, name: 'elicit_confirm' })
      ).resolves.toMatchObject({
        content: [{ text: 'echo-me', type: 'text' }],
        structuredContent: { confirmed: true, text: 'echo-me' },
      });
      expect(accepted.elicitations).toEqual(['Confirm the reference elicitation for "echo-me".']);
    } finally {
      await accepted.client.close();
    }

    const declined = await connectClient(handler, 'modern', () => ({ action: 'decline' }));
    try {
      await expect(
        declined.client.callTool({ arguments: { text: 'secret' }, name: 'elicit_confirm' })
      ).resolves.toMatchObject({
        structuredContent: { confirmed: false, text: 'elicitation was not accepted' },
      });
    } finally {
      await declined.client.close();
      await handler.close();
    }
  });

  it('cannot elicit over the stateless legacy reference and says so instead of echoing', async () => {
    // The legacy lab fixture is deliberately stateless (`legacy: 'stateless'`),
    // so the SDK server retains no client capabilities and refuses the 2025
    // push-style request. The packaged E2E therefore drives the modern OAuth
    // reference; this pins that the legacy path fails visibly, never silently.
    const handler = createMcpHandler(() => createReferenceServer('brainstrike-sdk-v2-reference'), {
      legacy: 'stateless',
    });
    const session = await connectClient(handler, 'legacy', () => ({
      action: 'accept',
      content: { confirm: true },
    }));
    try {
      expect(session.client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      await expect(
        session.client.callTool({ arguments: { text: 'echo-me' }, name: 'elicit_confirm' })
      ).resolves.toMatchObject({
        content: [{ text: 'Client does not support form elicitation.', type: 'text' }],
        isError: true,
      });
      expect(session.elicitations).toEqual([]);
    } finally {
      await session.client.close();
      await handler.close();
    }
  });
});
