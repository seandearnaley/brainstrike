import { buildModelSettingsOption } from '@brainstrike/agent/provider-request';
import {
  deriveEffectiveInputBudget,
  findLlmModelDefinition,
} from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import {
  desktopInputTokenLimit,
  readDesktopIntent,
} from '../agent-host-platform/desktop-run-preconditions';

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
