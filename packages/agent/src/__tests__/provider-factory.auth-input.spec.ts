/**
 * ProviderAuthInput seam (BST-1352): createProvider accepts a discriminated
 * auth union instead of a bare key string. `api_key` is behavior-identical to
 * the old string; `aws` is validated (region required) and consumed only by
 * the bedrock case. Kinds a provider case cannot thread fail with a typed error — never a
 * silent downgrade to env/default credentials.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MastraAgentError } from '../mastra-boundary/mastra-agent-error';
import type { ProviderAuthInput } from '../providers/provider-auth-input';
import { createProvider } from '../providers/provider-factory';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

    it('keeps the lmstudio dummy-key substitution when the api_key is empty', () => {
      expect(createProvider('lmstudio', { apiKey: '', kind: 'api_key' }, 'qwen2.5')).toEqual({
        apiKey: 'lmstudio',
        modelId: 'qwen2.5',
        providerId: 'lmstudio',
        url: 'http://127.0.0.1:1234/v1',
      });
    });
  });

  describe('api_key wire request', () => {
    it('keeps the anthropic prompt-caching breakpoint on the wire', async () => {
      const { captured, fetch } = makeCapturingFetch(makeAnthropicSseResponse);
      vi.stubGlobal('fetch', fetch);
      const model = createProvider(
        'anthropic',
        { apiKey: 'fixture-key', kind: 'api_key' },
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
        throw new Error('fetch was not invoked');
      }
      expect(request.url).toContain('api.anthropic.com');
      // wrapAnthropicModelWithPromptCaching intercepts doStream: the tail cache
      // breakpoint is present in the body sent on the wire.
      const messages = request.body['messages'] as Record<string, unknown>[];
      const lastMessage = messages.at(-1);
      const lastContent = ((lastMessage?.['content'] ?? []) as Record<string, unknown>[]).at(-1);
      expect(lastContent?.['cache_control']).toEqual({ type: 'ephemeral' });
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
