import { describe, expect, it } from 'vitest';
import { OPENAI_CODEX_RECOMMENDED_MODEL_IDS } from '../openai-codex-defaults.js';
import { listProviderLlmModels, resolveDefaultModel } from '../provider-registry.js';

describe('OPENAI_CODEX_RECOMMENDED_MODEL_IDS (BST-1356)', () => {
  it('every recommended id exists in the registry openai-codex catalog', () => {
    const catalogIds = new Set(listProviderLlmModels('openai-codex').map((model) => model.id));
    for (const id of OPENAI_CODEX_RECOMMENDED_MODEL_IDS) {
      expect(catalogIds.has(id), `${id} must exist in the catalog`).toBe(true);
    }
  });

  it('includes the registry default model, so the composer default is DB-enabled too', () => {
    expect(OPENAI_CODEX_RECOMMENDED_MODEL_IDS).toContain(resolveDefaultModel('openai-codex'));
  });

  it('is non-empty (initializeProviderModelDefaults rejects an empty set)', () => {
    expect(OPENAI_CODEX_RECOMMENDED_MODEL_IDS.length).toBeGreaterThan(0);
  });

  it('carries the codex/ catalog prefix on every id', () => {
    // The catalog namespaces these ids; an unprefixed id here would silently
    // fail to match a catalog row and throw at enablement time.
    for (const id of OPENAI_CODEX_RECOMMENDED_MODEL_IDS) {
      expect(id.startsWith('codex/'), `${id} must be catalog-prefixed`).toBe(true);
    }
  });
});
