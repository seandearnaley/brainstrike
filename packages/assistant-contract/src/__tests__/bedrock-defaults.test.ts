import { describe, expect, it } from 'vitest';
import { BEDROCK_RECOMMENDED_MODEL_IDS } from '../bedrock-defaults.js';
import { listProviderLlmModels, resolveDefaultModel } from '../provider-registry.js';

describe('BEDROCK_RECOMMENDED_MODEL_IDS (BST-1350 finding 8)', () => {
  it('every recommended id exists in the registry bedrock catalog', () => {
    const catalogIds = new Set(listProviderLlmModels('bedrock').map((model) => model.id));
    for (const id of BEDROCK_RECOMMENDED_MODEL_IDS) {
      expect(catalogIds.has(id)).toBe(true);
    }
  });

  it('includes the registry default model, so the composer default is DB-enabled too', () => {
    expect(BEDROCK_RECOMMENDED_MODEL_IDS).toContain(resolveDefaultModel('bedrock'));
  });

  it('is non-empty (initializeProviderModelDefaults rejects an empty set)', () => {
    expect(BEDROCK_RECOMMENDED_MODEL_IDS.length).toBeGreaterThan(0);
  });
});
