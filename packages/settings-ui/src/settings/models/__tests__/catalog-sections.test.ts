import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG_FILTERS } from '../catalog-filters';
import type { CatalogRow } from '../catalog-projection';
import {
  buildCatalogView,
  sortCatalogRows,
  UNKNOWN_PROVIDER_SECTION_ID,
} from '../catalog-sections';
import { makeCatalogRow, makeDbProvider } from './catalog-test-harness';

const providers = [
  makeDbProvider('openai', 'OpenAI', 0),
  makeDbProvider('anthropic', 'Anthropic', 1),
  makeDbProvider('openrouter', 'OpenRouter', 2),
  makeDbProvider('transformers', 'Transformers.js', 3),
  makeDbProvider('cohere', 'Cohere', 4),
];

const rows: CatalogRow[] = [
  makeCatalogRow({
    enabled: true,
    id: 'gpt-a',
    name: 'GPT A',
    providerId: 'openai',
    providerName: 'OpenAI',
  }),
  makeCatalogRow({ id: 'gpt-b', name: 'GPT B', providerId: 'openai', providerName: 'OpenAI' }),
  makeCatalogRow({ id: 'claude-a', name: 'Claude A', providerId: 'anthropic' }),
  makeCatalogRow({
    id: 'or-a',
    name: 'Router A',
    providerId: 'openrouter',
    providerName: 'OpenRouter',
  }),
  makeCatalogRow({
    id: 'mini',
    name: 'MiniLM',
    providerId: 'transformers',
    providerName: 'Transformers.js',
    type: 'embedding',
  }),
  makeCatalogRow({
    id: 'ghost',
    name: 'Ghost',
    providerId: 'retired',
    providerName: 'Unknown provider',
  }),
];

describe('buildCatalogView', () => {
  it('groups rows by provider in DB order and puts unknown providers last', () => {
    const view = buildCatalogView({
      filters: DEFAULT_CATALOG_FILTERS,
      providers,
      rows,
      sort: null,
    });
    expect(view.sections.map((section) => section.providerId)).toEqual([
      'openai',
      'anthropic',
      'openrouter',
      'transformers',
      UNKNOWN_PROVIDER_SECTION_ID,
    ]);
    expect(view.sections[0]?.rows.map((row) => row.id)).toEqual(['gpt-a', 'gpt-b']);
  });

  it('omits providers that have no catalogued models', () => {
    const view = buildCatalogView({
      filters: DEFAULT_CATALOG_FILTERS,
      providers,
      rows,
      sort: null,
    });
    expect(view.providerStats.map((stat) => stat.providerId)).not.toContain('cohere');
  });

  it('labels each section with its provider runtime', () => {
    const view = buildCatalogView({
      filters: DEFAULT_CATALOG_FILTERS,
      providers,
      rows,
      sort: null,
    });
    const labels = Object.fromEntries(view.sections.map((s) => [s.providerId, s.runtimeLabel]));
    expect(labels).toEqual({
      [UNKNOWN_PROVIDER_SECTION_ID]: null,
      anthropic: 'Hosted',
      openai: 'Hosted',
      openrouter: 'Gateway',
      transformers: 'On device',
    });
  });

  it('hides sections without matches but keeps provider totals unfiltered', () => {
    const view = buildCatalogView({
      filters: { ...DEFAULT_CATALOG_FILTERS, query: 'gpt b' },
      providers,
      rows,
      sort: null,
    });
    expect(view.sections.map((section) => section.providerId)).toEqual(['openai']);
    expect(view.sections[0]).toMatchObject({ enabledCount: 1, totalCount: 2 });
    expect(view.sections[0]?.rows.map((row) => row.id)).toEqual(['gpt-b']);
    expect(view.providerStats).toHaveLength(5);
  });

  it('summarises the catalog with and without filters', () => {
    expect(
      buildCatalogView({ filters: DEFAULT_CATALOG_FILTERS, providers, rows, sort: null }).summary
    ).toEqual({
      enabledModels: 1,
      filtering: false,
      matchingModels: 6,
      matchingProviders: 5,
      totalModels: 6,
      totalProviders: 5,
    });
    expect(
      buildCatalogView({
        filters: { ...DEFAULT_CATALOG_FILTERS, type: 'embedding' },
        providers,
        rows,
        sort: null,
      }).summary
    ).toEqual({
      enabledModels: 1,
      filtering: true,
      matchingModels: 1,
      matchingProviders: 1,
      totalModels: 6,
      totalProviders: 5,
    });
  });
});

describe('sortCatalogRows', () => {
  const sortable = [
    makeCatalogRow({ contextWindow: 200_000, id: 'b', name: 'Beta', pricing: null }),
    makeCatalogRow({ contextWindow: null, id: 'n', name: 'Nil' }),
    makeCatalogRow({ contextWindow: 1_000_000, id: 'a', name: 'alpha' }),
    makeCatalogRow({ contextWindow: 200_000, id: 'c', name: 'Gamma' }),
  ];

  it('keeps catalog order when unsorted', () => {
    expect(sortCatalogRows(sortable, null)).toBe(sortable);
  });

  it('sorts numbers ascending and descending, absent last in BOTH directions, ties in catalog order', () => {
    const asc = sortCatalogRows(sortable, { column: 'context', direction: 'asc' });
    expect(asc.map((row) => row.id)).toEqual(['b', 'c', 'a', 'n']);
    const desc = sortCatalogRows(sortable, { column: 'context', direction: 'desc' });
    expect(desc.map((row) => row.id)).toEqual(['a', 'b', 'c', 'n']);
  });

  it('sorts names case-insensitively and price by the input rate', () => {
    expect(
      sortCatalogRows(sortable, { column: 'name', direction: 'asc' }).map((row) => row.id)
    ).toEqual(['a', 'b', 'c', 'n']);
    expect(
      sortCatalogRows(sortable, { column: 'price', direction: 'desc' }).map((row) => row.id)
    ).toEqual(['n', 'a', 'c', 'b']);
  });

  it('sorts inside each section only', () => {
    const view = buildCatalogView({
      filters: DEFAULT_CATALOG_FILTERS,
      providers,
      rows,
      sort: { column: 'name', direction: 'desc' },
    });
    expect(view.sections[0]?.rows.map((row) => row.id)).toEqual(['gpt-b', 'gpt-a']);
    expect(view.sections[1]?.providerId).toBe('anthropic');
  });
});
