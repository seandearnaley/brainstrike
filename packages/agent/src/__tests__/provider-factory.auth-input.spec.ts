/**
 * ProviderAuthInput seam (BST-1352): createProvider accepts a discriminated
 * auth union instead of a bare key string. `api_key` is behavior-identical to
 * the old string; `custom_fetch` threads an injected fetch into the AI SDK
 * factories; `aws` is validated (region required) but consumed by no provider
 * yet. Kinds a provider case cannot thread fail with a typed error — never a
 * silent downgrade to env/default credentials.
 */
import { describe, expect, it } from 'vitest';
import { MastraAgentError } from '../mastra/mastra-agent-error';
import type { ProviderAuthInput } from '../providers/provider-auth-input';
import { createProvider } from '../providers/provider-factory';

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeAnthropicSseResponse(): Response {
  const events =
    sseEvent('message_start', {
      message: {
        content: [],
        id: 'msg_auth_input_test',
        model: 'claude-sonnet-4-6',
        role: 'assistant',
        stop_reason: null,
        stop_sequence: null,
        type: 'message',
        usage: { input_tokens: 1, output_tokens: 0 },
      },
      type: 'message_start',
    }) + sseEvent('message_stop', { type: 'message_stop' });
  return new Response(events, {
    headers: { 'content-type': 'text/event-stream' },
    status: 200,
  });
}

interface CapturedRequest {
  readonly body: Record<string, unknown>;
  readonly url: string;
}

function makeCapturingFetch(response: () => Response): {
  captured: CapturedRequest[];
  fetch: typeof globalThis.fetch;
} {
  const captured: CapturedRequest[] = [];
  const capturingFetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const rawBody =
      typeof init?.body === 'string'
        ? init.body
        : await new Request(input as RequestInfo, init).text();
    captured.push({ body: JSON.parse(rawBody) as Record<string, unknown>, url });
    return response();
  };
  return { captured, fetch: capturingFetch };
}

describe('createProvider ProviderAuthInput seam (BST-1352)', () => {
  describe('api_key kind (behavior parity with the old bare string)', () => {
    it('creates hosted models exactly like the old string argument', () => {
      const auth: ProviderAuthInput = { apiKey: 'test-key', kind: 'api_key' };
      expect((createProvider('openai', auth) as { modelId: string }).modelId).toBeDefined();
      expect((createProvider('anthropic', auth) as { modelId: string }).modelId).toBeDefined();
      expect((createProvider('google', auth) as { modelId: string }).modelId).toBeDefined();
    });

    it('keeps the ollama dummy-key substitution when the api_key is empty', () => {
      expect(createProvider('ollama', { apiKey: '', kind: 'api_key' }, 'qwen2.5:latest')).toEqual({
        apiKey: 'ollama',
        id: 'ollama/qwen2.5:latest',
        url: 'http://127.0.0.1:11434/v1',
      });
    });
  });

  describe('custom_fetch kind', () => {
    it('threads the injected fetch into the anthropic case AND keeps the prompt-caching wrapper', async () => {
      const { captured, fetch } = makeCapturingFetch(makeAnthropicSseResponse);
      const model = createProvider(
        'anthropic',
        { apiKey: 'dummy-never-sent', fetch, kind: 'custom_fetch' },
        'claude-sonnet-4-6'
      ) as {
        doStream: (options: unknown) => Promise<unknown>;
      };

      await model.doStream({
        prompt: [{ content: [{ text: 'hi', type: 'text' }], role: 'user' }],
      });

      expect(captured).toHaveLength(1);
      const request = captured[0];
      if (!request) {
        throw new Error('injected fetch was not invoked');
      }
      expect(request.url).toContain('api.anthropic.com');
      // wrapAnthropicModelWithPromptCaching still intercepts doStream on a
      // model built with a custom fetch: the tail cache breakpoint is present
      // in the body the injected fetch received.
      const messages = request.body['messages'] as Record<string, unknown>[];
      const lastMessage = messages.at(-1);
      const lastContent = ((lastMessage?.['content'] ?? []) as Record<string, unknown>[]).at(-1);
      expect(lastContent?.['cache_control']).toEqual({ type: 'ephemeral' });
    });

    it('threads the injected fetch into the openai case', async () => {
      const { captured, fetch } = makeCapturingFetch(
        () => new Response('{}', { status: 500 }) // reaching fetch at all is the assertion
      );
      const model = createProvider('openai', {
        apiKey: 'dummy-never-sent',
        fetch,
        kind: 'custom_fetch',
      }) as {
        doGenerate: (options: unknown) => Promise<unknown>;
      };
      await model
        .doGenerate({ prompt: [{ content: [{ text: 'hi', type: 'text' }], role: 'user' }] })
        .catch(() => {
          // The 500 fixture makes the SDK throw AFTER the fetch we assert on.
        });
      expect(captured.length).toBeGreaterThan(0);
    });

    it('threads the injected fetch into the google case', async () => {
      const { captured, fetch } = makeCapturingFetch(() => new Response('{}', { status: 500 }));
      const model = createProvider('google', {
        apiKey: 'dummy-never-sent',
        fetch,
        kind: 'custom_fetch',
      }) as {
        doGenerate: (options: unknown) => Promise<unknown>;
      };
      await model
        .doGenerate({ prompt: [{ content: [{ text: 'hi', type: 'text' }], role: 'user' }] })
        .catch(() => {
          // Same 500-after-capture contract as the openai case.
        });
      expect(captured.length).toBeGreaterThan(0);
    });

    it('throws a typed error for provider cases with no fetch seam (never drops the fetch)', () => {
      const auth: ProviderAuthInput = {
        apiKey: 'dummy',
        fetch: globalThis.fetch,
        kind: 'custom_fetch',
      };
      for (const provider of ['openrouter', 'ollama', 'lmstudio', 'local'] as const) {
        let thrown: unknown;
        try {
          createProvider(provider, auth, 'some-model');
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(MastraAgentError);
        expect((thrown as MastraAgentError).code).toBe('mastra_agent_runtime_init_failed');
        expect((thrown as MastraAgentError).message).toContain('custom_fetch');
      }
    });
  });

  // The bedrock case CONSUMES the aws kind — its coverage lives in
  // provider-factory.bedrock.spec.ts; every other case still fails typed.
  describe('aws kind (consumed only by the bedrock case — BST-1350)', () => {
    it('rejects an aws auth input without a region with a typed error', () => {
      let thrown: unknown;
      try {
        createProvider('openai', { kind: 'aws', region: '' });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MastraAgentError);
      expect((thrown as MastraAgentError).code).toBe('mastra_agent_runtime_init_failed');
      expect((thrown as MastraAgentError).message).toContain('region');
    });

    it('rejects a valid aws auth input on every non-bedrock provider case', () => {
      // A COMPLETE aws input (bearer present, so it clears the BST-1353
      // bearer-XOR-chain check): this test is about provider ROUTING, so the
      // input must fail only because the provider cannot consume it.
      const auth: ProviderAuthInput = {
        apiKey: 'bedrock-bearer',
        kind: 'aws',
        region: 'us-east-1',
      };
      for (const provider of [
        'openai',
        'anthropic',
        'google',
        'openrouter',
        'ollama',
        'lmstudio',
        'local',
      ] as const) {
        let thrown: unknown;
        try {
          createProvider(provider, auth, 'some-model');
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(MastraAgentError);
        expect((thrown as MastraAgentError).code).toBe('mastra_agent_runtime_init_failed');
        expect((thrown as MastraAgentError).message).toContain('aws');
      }
    });
  });
});
