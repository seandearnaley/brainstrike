import { describe, expect, it } from 'vitest';
import {
  getProviderModelDefaultPolicy,
  PROVIDER_MODEL_DEFAULT_POLICIES,
} from '../provider-model-default-policies.js';
import { listProviders } from '../provider-registry.js';

describe('PROVIDER_MODEL_DEFAULT_POLICIES', () => {
  it('covers every provider in the catalog', () => {
    const catalogIds = listProviders()
      .map((provider) => provider.id)
      .sort();
    expect(Object.keys(PROVIDER_MODEL_DEFAULT_POLICIES).sort()).toEqual(catalogIds);
  });

  it('is null exactly for providers that cannot have catalog defaults', () => {
    // Derived, not listed: a provider has catalog defaults only when it is
    // keyed AND serves LLMs. Keyless runtimes get enablement from discovery;
    // embedding-only providers have no LLM rows to enable.
    for (const provider of listProviders()) {
      const expectsNull = provider.authType === 'none' || !provider.capabilities.llm;
      expect({
        id: provider.id,
        isNull: PROVIDER_MODEL_DEFAULT_POLICIES[provider.id] === null,
      }).toEqual({ id: provider.id, isNull: expectsNull });
    }
  });

  it('gives the three first-party keyed providers an availability policy', () => {
    for (const id of ['anthropic', 'google', 'openai'] as const) {
      expect(getProviderModelDefaultPolicy(id)).toEqual({ kind: 'all' });
    }
  });

  it("declares every seed id in that provider's own registry entry", () => {
    for (const provider of listProviders()) {
      const policy = PROVIDER_MODEL_DEFAULT_POLICIES[provider.id];
      if (policy?.kind !== 'seed') {
        continue;
      }
      const registryIds = new Set(provider.models.map((model) => model.id));
      const unknown = policy.modelIds.filter((modelId) => !registryIds.has(modelId));
      expect({ id: provider.id, unknown }).toEqual({ id: provider.id, unknown: [] });
    }
  });

  it('never declares an empty seed set', () => {
    for (const policy of Object.values(PROVIDER_MODEL_DEFAULT_POLICIES)) {
      if (policy?.kind === 'seed') {
        expect(policy.modelIds.length).toBeGreaterThan(0);
      }
    }
  });
});
