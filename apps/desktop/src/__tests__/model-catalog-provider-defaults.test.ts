import type {
  ModelChoice,
  ModelChoicePort,
  ModelChoiceRequest,
  ModelChoiceResult,
} from '@brainstrike/state-store';
import { describe, expect, it } from 'vitest';
import { createDesktopModelCatalog } from '../model-catalog.ts';

/** An in-memory choice writer: `initialize` turns the named models on. */
function memoryChoices(): ModelChoicePort {
  const models = new Map<string, ModelChoice>();
  const snapshot = (): ModelChoiceResult => ({ models: [...models.values()], providers: [] });
  return {
    modelChoices: async (request: ModelChoiceRequest) => {
      if (request.operation === 'initialize') {
        for (const modelId of request.modelIds) {
          models.set(modelId, { enabled: true, modelId, providerId: request.providerId });
        }
        return { ...snapshot(), outcome: 'initialized' };
      }
      if (request.operation === 'models') {
        for (const choice of request.models) {
          models.set(choice.modelId, choice);
        }
      }
      return snapshot();
    },
  };
}

describe('provider defaults under the all-models policy', () => {
  it('never turn on an archived model, and leave one already on as it is', async () => {
    const catalog = createDesktopModelCatalog(memoryChoices());
    const { snapshot } = await catalog.initializeProviderDefaults('anthropic', { kind: 'all' });
    const enabled = (id: string) => snapshot.models.find((model) => model.id === id)?.isEnabled;

    // Claude Opus 5 is archived and ships off: adding a key keeps it off.
    expect(enabled('claude-opus-5')).toBe(false);
    // Claude Fable 5.1 is archived but ships on: archiving never switches it off.
    expect(enabled('claude-fable-5-1')).toBe(true);
    expect(enabled('claude-fable-5-2')).toBe(true);
  });
});
