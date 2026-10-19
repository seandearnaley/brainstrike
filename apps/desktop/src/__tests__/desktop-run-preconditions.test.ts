import { buildModelSettingsOption } from '@brainstrike/agent/provider-request';
import {
  deriveEffectiveInputBudget,
  findLlmModelDefinition,
} from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import type { DesktopAdmissionReads } from '../agent-host-platform/desktop-run-admission';
import {
  desktopInputTokenLimit,
  readDesktopIntent,
  readDesktopLocalModel,
} from '../agent-host-platform/desktop-run-preconditions';
import type { PlatformLocalModel } from '../agent-host-platform/platform-wire';

test('an uncaptured OpenRouter CLI request records the canonical output limit before deriving its input budget', async () => {
  const model = 'anthropic/claude-sonnet-4.6';
  const provider = 'openrouter';
  const definition = findLlmModelDefinition(provider, model);
  if (!definition) {
    throw new Error('The recorded OpenRouter model is absent');
  }
  const catalog = { definition, model, provider } as const;
  const request = {
    modelId: `${provider}::${model}`,
    signal: new AbortController().signal,
    threadId: 'cli-budget-proof',
  };
  const intent = await readDesktopIntent(request, catalog);
  const outputLimit = intent.modelConfiguration.modelSettings?.maxOutputTokens;
  expect(outputLimit).toBeGreaterThan(0);
  expect(intent.modelConfiguration).toEqual({
    model,
    provider,
    ...buildModelSettingsOption({ model, provider }),
  });
  expect(desktopInputTokenLimit(definition, intent, intent.modelConfiguration)).toBe(
    deriveEffectiveInputBudget(definition.contextWindow, outputLimit)
  );
  const captured = {
    ...intent,
    modelConfiguration: { model, modelSettings: { maxOutputTokens: 900 }, provider },
  };
  expect(await readDesktopIntent({ ...request, configuration: captured }, catalog)).toEqual(
    captured
  );
});

/** Main's local runtime catalog answering admission with one `/api/show` reading. */
function localModelReads(answer: PlatformLocalModel) {
  const asked: unknown[] = [];
  const reads = {
    localRuntimeModel: async (target: unknown) => {
      asked.push(target);
      return answer;
    },
  } as unknown as DesktopAdmissionReads;
  return { asked, reads };
}
const signal = new AbortController().signal;
const noAuth = async () => undefined;
const resolved = (
  contextLength: Extract<PlatformLocalModel, { state: 'resolved' }>['contextLength'],
  thinking = false
): PlatformLocalModel => ({
  contextLength,
  endpoint: 'http://gpu.lan:11434/api/show',
  state: 'resolved',
  thinking,
});

test('an Ollama run is admitted at the window its model reports, capped, at its configured endpoint (BST-754)', async () => {
  const { asked, reads } = localModelReads(
    resolved({ key: 'gemma4.context_length', state: 'reported', tokens: 262_144 }, true)
  );
  const configuration = {
    model: 'gemma4:31b',
    provider: 'ollama',
    providerOptions: { ollama: { apiToken: 'tok', baseUrl: 'http://gpu.lan:11434' } },
  };
  await expect(readDesktopLocalModel(reads, configuration, signal, noAuth)).resolves.toEqual({
    contextWindow: 32_768,
    thinking: true,
  });
  expect(asked).toEqual([
    { endpoint: { apiToken: 'tok', baseUrl: 'http://gpu.lan:11434' }, model: 'gemma4:31b' },
  ]);
});

test.each([
  [resolved({ key: 'phi3.context_length', state: 'reported', tokens: 16_384 }), 16_384],
  [resolved({ state: 'unreported' }), 32_768],
  [resolved({ detail: 'conflicting context lengths', state: 'malformed' }), 32_768],
])('an Ollama model reading %j is admitted at %i tokens', async (answer, contextWindow) => {
  const { reads } = localModelReads(answer);
  await expect(
    readDesktopLocalModel(reads, { model: 'phi4', provider: 'ollama' }, signal, noAuth)
  ).resolves.toEqual({ contextWindow, thinking: false });
});

test('an Ollama server that cannot describe the model refuses the run, saying why', async () => {
  const { reads } = localModelReads({
    endpoint: 'http://127.0.0.1:11434/api/show',
    message: 'Ollama /api/show responded with 404',
    state: 'unavailable',
  });
  await expect(
    readDesktopLocalModel(reads, { model: 'missing', provider: 'ollama' }, signal, noAuth)
  ).rejects.toThrow(
    'Ollama could not describe "missing" at http://127.0.0.1:11434/api/show: Ollama /api/show responded with 404'
  );
});

test('a run on any other provider reads no local model', async () => {
  const { asked, reads } = localModelReads(resolved({ state: 'unreported' }));
  await expect(
    readDesktopLocalModel(reads, { model: 'qwen2.5', provider: 'lmstudio' }, signal, noAuth)
  ).resolves.toBeUndefined();
  expect(asked).toEqual([]);
});

test("the admission lookup carries the host's stored Ollama credential, before a configured token (BST-754)", async () => {
  const { asked, reads } = localModelReads(resolved({ state: 'unreported' }));
  const configuration = {
    model: 'qwen3',
    provider: 'ollama',
    providerOptions: { ollama: { apiToken: 'configured', baseUrl: 'https://gpu.lan' } },
  };
  await readDesktopLocalModel(reads, configuration, signal, async () => ({
    apiKey: 'stored',
    kind: 'api_key' as const,
  }));
  await readDesktopLocalModel(reads, configuration, signal, noAuth);
  expect(asked).toEqual([
    { endpoint: { apiToken: 'stored', baseUrl: 'https://gpu.lan' }, model: 'qwen3' },
    { endpoint: { apiToken: 'configured', baseUrl: 'https://gpu.lan' }, model: 'qwen3' },
  ]);
  await expect(
    readDesktopLocalModel(reads, { model: 'qwen3', provider: 'ollama' }, signal, undefined)
  ).rejects.toThrow("An Ollama run needs the host's credential authority");
});
