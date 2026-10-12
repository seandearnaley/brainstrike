// @vitest-environment node
import type { ProductionHostRunConfiguration } from '@brainstrike/agent-host';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createDesktopHostMemoryConfiguration } from '../agent-host-platform/memory-model-configuration';
import { PlatformSelectionSchema } from '../agent-host-platform/platform-wire';

async function invokeObserver(memory: ProductionHostRunConfiguration['memory']): Promise<unknown> {
  const observation = memory.native.options?.observationalMemory;
  if (!observation || typeof observation !== 'object') {
    throw new Error('Expected an enabled observer');
  }
  const model = observation.model;
  if (
    !model ||
    typeof model !== 'object' ||
    !('specificationVersion' in model) ||
    model.specificationVersion !== 'v4'
  ) {
    throw new Error('Expected the materialized SDK 7 observer');
  }
  return await model.doGenerate({
    prompt: [
      {
        content: [{ text: 'Recorded observer request input', type: 'text' }],
        role: 'user',
      },
    ],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test.each(['openai', 'anthropic', 'google', 'openrouter'] as const)(
  'the configured %s observer sends its selected credential through the real SDK',
  async (provider) => {
    const selectedCredential = 'synthetic-selected-observer-key';
    for (const name of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'OPENROUTER_API_KEY',
    ]) {
      vi.stubEnv(name, 'synthetic-unselected-ambient-key');
    }
    const captures: { body: Record<string, unknown>; headers: Headers; url: URL }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      captures.push({
        body: z.record(z.string(), z.json()).parse(JSON.parse(await request.text())),
        headers: request.headers,
        url: new URL(request.url),
      });
      // The actual SDK failure proves dispatch and auth without live inference.
      return new Response(null, { status: 400, statusText: 'Offline observer fixture' });
    });
    const modelId = provider === 'openrouter' ? 'vendor/observer-fixture' : 'observer-fixture';
    const selection = PlatformSelectionSchema.parse({
      configuration: { model: 'chat-fixture', provider: 'anthropic' },
      contextWindow: 32_000,
      durableConfiguration: {},
      inputTokenLimit: 24_000,
      maxSteps: 5,
      memory: {
        options: {
          lastMessages: 12,
          workingMemory: { enabled: true, scope: 'resource', template: '' },
        },
        settings: {
          ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
          observationalMemory: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.observationalMemory,
            enabled: true,
            modelTarget: `${provider}/${modelId}`,
            retrievalMode: 'off',
          },
          semanticRecall: {
            ...DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS.semanticRecall,
            enabled: false,
          },
        },
      },
      nativeRuntime: { provider: 'anthropic', workspaceRoots: [] },
      resourceId: 'workspace-fixture',
      tools: {},
      toolTimeoutMs: 5000,
    });
    const memory = await createDesktopHostMemoryConfiguration(selection, async () => ({
      apiKey: selectedCredential,
      kind: 'api_key',
    }));
    await expect(invokeObserver(memory)).rejects.toMatchObject({ statusCode: 400 });
    expect(captures).toHaveLength(1);
    const request = captures[0];
    if (!request) {
      throw new Error('The configured observer did not issue a request');
    }
    if (provider === 'google') {
      expect(request.headers.get('x-goog-api-key')).toBe(selectedCredential);
      expect(request.url.pathname).toContain(`/models/${modelId}:`);
      expect(request.body['contents']).toEqual(expect.any(Array));
    } else {
      expect(request.headers.get(provider === 'anthropic' ? 'x-api-key' : 'authorization')).toBe(
        provider === 'anthropic' ? selectedCredential : `Bearer ${selectedCredential}`
      );
      expect(request.body['model']).toBe(modelId);
      expect(request.body[provider === 'openai' ? 'input' : 'messages']).toEqual(expect.any(Array));
    }
  }
);
