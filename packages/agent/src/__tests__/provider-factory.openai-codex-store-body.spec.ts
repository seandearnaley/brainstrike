import { describe, expect, it } from 'vitest';
import { createProvider } from '../providers/provider-factory';

interface RequestItem {
  encrypted_content?: string;
  id?: string;
  type?: string;
}

interface RequestBody {
  include?: string[];
  input: RequestItem[];
  store?: boolean;
}

describe('provider-factory openai-codex serialized request body (BST-1918)', () => {
  it('serializes a store:false request with inline encrypted reasoning and no item_reference', async () => {
    const bodies: RequestBody[] = [];
    const fetchImpl = (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)) as RequestBody);
      return Promise.resolve(
        new Response('{"error":{"message":"stop"}}', {
          headers: { 'content-type': 'application/json' },
          status: 400,
        })
      );
    };

    const model = createProvider(
      'openai-codex',
      {
        apiKey: 'oauth-subscription-no-api-key',
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
        kind: 'custom_fetch',
      },
      'codex/gpt-5.5'
    ) as unknown as { doStream: (params: never) => Promise<unknown> };

    try {
      await model.doStream({
        prompt: [
          { content: [{ text: 'Read a file', type: 'text' }], role: 'user' },
          {
            content: [
              {
                providerOptions: {
                  openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ENC_1' },
                },
                text: 'I should read it.',
                type: 'reasoning',
              },
              {
                input: { path: 'a.ts' },
                providerOptions: { openai: { itemId: 'fc_1' } },
                toolCallId: 'call_1',
                toolName: 'read_file',
                type: 'tool-call',
              },
            ],
            role: 'assistant',
          },
          {
            content: [
              {
                output: { type: 'text', value: 'contents' },
                toolCallId: 'call_1',
                toolName: 'read_file',
                type: 'tool-result',
              },
            ],
            role: 'tool',
          },
        ],
        tools: [
          {
            description: 'Read a file',
            inputSchema: {
              additionalProperties: false,
              properties: { path: { type: 'string' } },
              required: ['path'],
              type: 'object',
            },
            name: 'read_file',
            type: 'function',
          },
        ],
      } as never);
    } catch {
      // The 400 response aborts the call; only the captured request body matters.
    }

    const body = bodies[0];
    expect(body).toBeDefined();
    expect(body?.store).toBe(false);
    expect(body?.input.some((item) => item.type === 'item_reference')).toBe(false);
    expect(body?.input).toContainEqual(
      expect.objectContaining({ encrypted_content: 'ENC_1', id: 'rs_1', type: 'reasoning' })
    );
    expect(body?.include).toContain('reasoning.encrypted_content');
  });
});
