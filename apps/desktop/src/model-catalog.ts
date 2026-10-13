import {
  type ModelCatalogCapability,
  type ModelCatalogSnapshot,
  projectModelCatalog,
} from '@brainstrike/assistant-contract';
import type { ModelChoicePort } from '@brainstrike/state-store';

/** Static facts are projected once per read; only explicit choices cross the host writer. */
export function createDesktopModelCatalog(store: ModelChoicePort): ModelCatalogCapability {
  const initial = projectModelCatalog({ models: [], providers: [] });
  function requireProvider(providerId: string): void {
    if (!initial.providers.some((provider) => provider.id === providerId)) {
      throw new Error(`Unknown model catalog provider: ${providerId}`);
    }
  }
  const read = async (): Promise<ModelCatalogSnapshot> =>
    projectModelCatalog(await store.modelChoices({ operation: 'snapshot' }));
  return {
    initializeProviderDefaults: async (providerId, policy) => {
      requireProvider(providerId);
      const catalog = initial.models.filter((model) => model.providerId === providerId);
      const modelIds =
        policy.kind === 'all'
          ? catalog
              .filter((model) => model.capabilities.type === 'llm' && !model.isEnabled)
              .map((model) => model.id)
          : [...new Set(policy.modelIds)];
      if (policy.kind === 'seed' && modelIds.length === 0) {
        throw new Error('Recommended model defaults are empty.');
      }
      if (modelIds.some((id) => !catalog.some((model) => model.id === id))) {
        throw new Error('Recommended model defaults reference an unknown catalog identity.');
      }
      if (
        modelIds.length === 0 ||
        (policy.kind === 'seed' && catalog.some((model) => model.isEnabled))
      ) {
        return { outcome: 'preserved', snapshot: await read() };
      }
      const result = await store.modelChoices({
        modelIds,
        operation: 'initialize',
        policy: policy.kind,
        providerId,
      });
      if (!result.outcome) {
        throw new Error('Model default writer omitted its outcome.');
      }
      return { outcome: result.outcome, snapshot: projectModelCatalog(result) };
    },
    read,
    setModels: async (modelIds, enabled) => {
      if (modelIds.length === 0) {
        throw new Error('Model choice batch is empty.');
      }
      const models = [...new Set(modelIds)].map((modelId) => {
        const model = initial.models.find((candidate) => candidate.id === modelId);
        if (!model) {
          throw new Error(`Unknown model catalog identity: ${modelId}`);
        }
        return { enabled, modelId, providerId: model.providerId };
      });
      const result = await store.modelChoices({ models, operation: 'models' });
      if (!result.previous) {
        throw new Error('Model choice writer omitted its atomic prior snapshot.');
      }
      const previous = projectModelCatalog(result.previous);
      return {
        previous: models.map(({ modelId }) => {
          const prior = previous.models.find((model) => model.id === modelId);
          if (!prior) {
            throw new Error('Atomic prior model choice is missing.');
          }
          return { enabled: prior.isEnabled, modelId };
        }),
        snapshot: projectModelCatalog(result),
      };
    },
    setProvider: async (providerId, enabled) => {
      requireProvider(providerId);
      return projectModelCatalog(
        await store.modelChoices({ enabled, operation: 'provider', providerId })
      );
    },
  };
}
