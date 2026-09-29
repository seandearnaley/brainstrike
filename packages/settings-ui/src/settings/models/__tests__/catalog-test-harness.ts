import type { DbModel, DbProvider } from '@brainstrike/app-state/stores/model-registry-store';
import type { CatalogRow } from '../catalog-projection';

export function makeDbModel(overrides: Partial<DbModel> & Pick<DbModel, 'id'>): DbModel {
  return {
    bestFor: null,
    capabilities: { type: 'llm' },
    description: null,
    icon: null,
    isEnabled: false,
    name: overrides.id,
    parameters: null,
    providerId: 'openai',
    sortOrder: 0,
    tagline: null,
    ...overrides,
  };
}

export function makeDbProvider(id: string, name: string, sortOrder: number): DbProvider {
  return { icon: null, id, isEnabled: true, name, sortOrder };
}

export function makeCatalogRow(
  overrides: Partial<CatalogRow> & Pick<CatalogRow, 'id'>
): CatalogRow {
  return {
    bestFor: [],
    contextWindow: 200_000,
    description: null,
    dimension: null,
    enabled: false,
    isLocal: false,
    maxOutputTokens: 64_000,
    name: overrides.id,
    pricing: {
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
      inputPerMTok: 3,
      outputPerMTok: 15,
    },
    providerId: 'anthropic',
    providerName: 'Anthropic',
    reasoning: { source: 'model', state: 'supported' },
    reasoningEfforts: ['low', 'medium', 'high'],
    recommended: false,
    registered: true,
    sizeLabel: null,
    tagline: null,
    type: 'chat',
    vision: 'supported',
    ...overrides,
  };
}
