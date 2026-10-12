// @vitest-environment node
import { readFileSync } from 'node:fs';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import {
  type OpenRouterModelMetadataLookup,
  parseOpenRouterModelMetadata,
} from '@brainstrike/assistant-contract';
import { afterEach, expect, it } from 'vitest';
import { readDesktopHostConfiguration } from '../renderer/desktop-host-configuration';

const MODEL = 'anthropic/claude-sonnet-4.6';
// The recorded OpenRouter metadata the E2E shim serves: efforts low..max.
const recorded: unknown = JSON.parse(
  readFileSync(
    new URL('./fixtures/openrouter-sonnet-4-6-model-metadata.json', import.meta.url),
    'utf8'
  )
);
const initial = useAssistantPreferencesStore.getState();

afterEach(() => {
  useAssistantPreferencesStore.setState(initial, true);
});

/**
 * BST-1932 (AT-09): the composer offers the efforts the model's live metadata
 * declares, so Send must capture them under that same metadata, as the legacy
 * Send built its draft with the panel's OpenRouter lookup.
 */
it('captures an effort only the model metadata declares, under that metadata', () => {
  useAssistantPreferencesStore.setState({
    providerSettings: {
      ...initial.providerSettings,
      openrouter: { ...initial.providerSettings.openrouter, reasoningEffort: 'max' },
    },
    selectedModel: `openrouter::${MODEL}`,
  });
  const lookup: OpenRouterModelMetadataLookup = {
    snapshot: { freshness: 'live', metadata: parseOpenRouterModelMetadata(recorded, MODEL, 0) },
    state: 'resolved',
  };
  const captured = readDesktopHostConfiguration(
    'effort-thread',
    `openrouter::${MODEL}`,
    null,
    undefined,
    lookup
  );
  expect(captured).toMatchObject({
    modelConfiguration: {
      model: MODEL,
      provider: 'openrouter',
      providerOptions: { openrouter: { reasoning: { effort: 'max' } } },
    },
  });
});
