import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ParsedEmbeddingModel,
  type ParsedLlmModel,
  type ParsedProvider,
  ProviderCatalogSchema,
  parseProviderCatalog,
} from '../provider-catalog-schema.js';
import type {
  EmbeddingModelDefinition,
  LlmModelDefinition,
  ProviderDefinition,
} from '../provider-registry.js';

/**
 * BST-1650: the catalog moved out of the TypeScript literal into
 * `provider-catalog.json`, so the compile-time guarantee that every LLM entry
 * declares `contextWindow` and `vision` is gone. The Zod schema is what
 * replaces it, and it must fail CLOSED at module load — never coerce, never
 * fall back to a partial catalog (repo rule: NO SILENT FALLBACKS).
 *
 * Fixtures are BUILT malformed rather than mutated into shape: JSON cannot
 * express `undefined`, so "the key is absent" is the only failure a real
 * catalog file can produce, and a `key: undefined` fixture would exercise a
 * different Zod path than the one that ships.
 */

const WELL_FORMED_MODEL: Record<string, unknown> = {
  contextWindow: 400_000,
  id: 'gpt-5.6-sol',
  type: 'llm',
  vision: 'supported',
};

function catalogWith(model: Record<string, unknown>, providerNote?: string): unknown {
  const provider: Record<string, unknown> = {
    authType: 'api_key',
    capabilities: { embeddings: false, llm: true, streaming: true },
    displayName: 'OpenAI',
    envKeys: ['BRAINSTRIKE_OPENAI_API_KEY', 'OPENAI_API_KEY'],
    id: 'openai',
    models: [model],
    runtime: 'hosted',
  };
  if (providerNote !== undefined) {
    provider['_note'] = providerNote;
  }
  return [provider];
}

function modelWithout(key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(WELL_FORMED_MODEL).filter(([name]) => name !== key));
}

describe('ProviderCatalogSchema', () => {
  it('accepts a well-formed catalog', () => {
    expect(() => ProviderCatalogSchema.parse(catalogWith(WELL_FORMED_MODEL))).not.toThrow();
  });

  it('rejects an LLM model entry that omits the required vision capability', () => {
    expect(() => ProviderCatalogSchema.parse(catalogWith(modelWithout('vision')))).toThrowError(
      /"path":\s*\[\s*0,\s*"models",\s*0,\s*"vision"\s*\]/
    );
  });

  it('rejects an LLM model entry that omits the required contextWindow', () => {
    expect(() =>
      ProviderCatalogSchema.parse(catalogWith(modelWithout('contextWindow')))
    ).toThrowError(/"contextWindow"/);
  });

  it('rejects an unknown key rather than silently dropping it', () => {
    expect(() =>
      ProviderCatalogSchema.parse(catalogWith({ ...WELL_FORMED_MODEL, visoin: 'supported' }))
    ).toThrowError(/visoin/);
  });

  it('rejects a vision value outside the declared union', () => {
    expect(() =>
      ProviderCatalogSchema.parse(catalogWith({ ...WELL_FORMED_MODEL, vision: 'maybe' }))
    ).toThrowError(/invalid_value|invalid_union/);
  });
});

/**
 * The schema's literal unions are hand-mirrored from `provider-registry.ts`,
 * so drift has to be a COMPILE error rather than a runtime surprise. These
 * assignments check both directions: a union member (or whole field) present
 * on one side and missing on the other fails `pnpm type-check`. They are
 * type-level only — `tsconfig.test.json` covers this file.
 */
function assertSchemaMatchesTypes(): void {
  const providerForward: ProviderDefinition = {} as ParsedProvider;
  const providerBackward: ParsedProvider = {} as ProviderDefinition;
  const llmForward: LlmModelDefinition = {} as ParsedLlmModel;
  const llmBackward: ParsedLlmModel = {} as LlmModelDefinition;
  const embeddingForward: EmbeddingModelDefinition = {} as ParsedEmbeddingModel;
  const embeddingBackward: ParsedEmbeddingModel = {} as EmbeddingModelDefinition;
  void [
    providerForward,
    providerBackward,
    llmForward,
    llmBackward,
    embeddingForward,
    embeddingBackward,
  ];
}

describe('provider catalog schema and registry types', () => {
  it('stay structurally identical in both directions', () => {
    expect(assertSchemaMatchesTypes).not.toThrow();
  });
});

describe('parseProviderCatalog', () => {
  it('names the offending provider and model instead of array indices', () => {
    expect(() =>
      parseProviderCatalog(catalogWith({ ...WELL_FORMED_MODEL, vision: 'maybe' }))
    ).toThrowError(/openai\.models\.gpt-5\.6-sol\.vision/);
  });

  it('keeps the ZodError as the thrown error cause', () => {
    try {
      parseProviderCatalog(catalogWith(modelWithout('contextWindow')));
      expect.unreachable('parseProviderCatalog must throw for a malformed catalog');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBeDefined();
    }
  });
});

describe('catalog provenance notes', () => {
  it('never reach a consumer of the parsed definitions', () => {
    const [provider] = parseProviderCatalog(
      catalogWith({ ...WELL_FORMED_MODEL, _note: 'model provenance' }, 'provider provenance')
    );

    expect(provider).toBeDefined();
    expect(Object.keys(provider ?? {})).not.toContain('_note');
    expect(Object.keys(provider?.models[0] ?? {})).not.toContain('_note');
  });

  it('do not disturb the declared key order of a definition', () => {
    const [provider] = parseProviderCatalog(catalogWith(WELL_FORMED_MODEL, 'provider provenance'));

    expect(Object.keys(provider ?? {})).toEqual([
      'authType',
      'capabilities',
      'displayName',
      'envKeys',
      'id',
      'models',
      'runtime',
    ]);
  });
});

describe('provider-registry module load', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws at import when the catalog data file is malformed', async () => {
    vi.doMock('../provider-catalog.json', () => ({
      default: catalogWith(modelWithout('vision')),
    }));

    await expect(import('../provider-registry.js')).rejects.toThrow(/vision/);
  });
});
