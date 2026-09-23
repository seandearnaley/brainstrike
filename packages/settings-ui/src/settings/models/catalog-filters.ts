import { matchesModelQuery } from '@brainstrike/ui';
import type { CatalogRow } from './catalog-projection';

export type CatalogStatusFilter = 'all' | 'disabled' | 'enabled';
export type CatalogTypeFilter = 'all' | 'chat' | 'embedding';
export type CatalogContextBand = '128k' | '1m' | '200k' | 'any';

export interface CatalogFilters {
  readonly context: CatalogContextBand;
  /** Empty means every provider. */
  readonly providerIds: ReadonlySet<string>;
  readonly query: string;
  readonly reasoning: boolean;
  readonly status: CatalogStatusFilter;
  readonly type: CatalogTypeFilter;
  readonly vision: boolean;
}

export const DEFAULT_CATALOG_FILTERS: CatalogFilters = {
  context: 'any',
  providerIds: new Set<string>(),
  query: '',
  reasoning: false,
  status: 'all',
  type: 'all',
  vision: false,
};

/** Inclusive lower bounds: a band means "at least this many tokens". */
export const CONTEXT_BAND_MIN_TOKENS = {
  '1m': 1_000_000,
  '128k': 128_000,
  '200k': 200_000,
} as const satisfies Record<Exclude<CatalogContextBand, 'any'>, number>;

export const CONTEXT_BAND_LABELS = {
  '1m': '≥ 1M',
  '128k': '≥ 128K',
  '200k': '≥ 200K',
  any: 'Any',
} as const satisfies Record<CatalogContextBand, string>;

/** Display order for the Context select. */
export const CONTEXT_BAND_OPTIONS: readonly CatalogContextBand[] = ['any', '128k', '200k', '1m'];

export function parseContextBand(value: string): CatalogContextBand {
  const band = CONTEXT_BAND_OPTIONS.find((option) => option === value);
  if (band === undefined) {
    throw new Error(`Unknown context band: ${value}`);
  }
  return band;
}

function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function matchesContext(row: CatalogRow, band: CatalogContextBand): boolean {
  if (band === 'any') {
    return true;
  }
  return row.contextWindow !== null && row.contextWindow >= CONTEXT_BAND_MIN_TOKENS[band];
}

function matchesQuery(row: CatalogRow, query: string): boolean {
  return matchesModelQuery(
    {
      keywords: row.bestFor,
      label: row.name,
      modelId: row.id,
      providerId: row.providerId,
      providerName: row.providerName,
      tagline: row.tagline,
    },
    query
  );
}

export function matchesCatalogFilters(row: CatalogRow, filters: CatalogFilters): boolean {
  return (
    (filters.status === 'all' || row.enabled === (filters.status === 'enabled')) &&
    (filters.type === 'all' || row.type === filters.type) &&
    (!filters.vision || row.vision === 'supported') &&
    (!filters.reasoning || row.reasoning?.state === 'supported') &&
    matchesContext(row, filters.context) &&
    (filters.providerIds.size === 0 || filters.providerIds.has(row.providerId)) &&
    matchesQuery(row, filters.query)
  );
}

export function isCatalogFilterActive(filters: CatalogFilters): boolean {
  return (
    queryWords(filters.query).length > 0 ||
    filters.status !== 'all' ||
    filters.type !== 'all' ||
    filters.vision ||
    filters.reasoning ||
    filters.context !== 'any' ||
    filters.providerIds.size > 0
  );
}

export type CatalogFilterKey =
  | 'context'
  | 'providers'
  | 'query'
  | 'reasoning'
  | 'status'
  | 'type'
  | 'vision';

export interface CatalogFilterChip {
  readonly key: CatalogFilterKey;
  readonly label: string;
}

function describeProviders(
  providerIds: ReadonlySet<string>,
  providerNames: ReadonlyMap<string, string>
): string {
  if (providerIds.size > 2) {
    return `${providerIds.size} providers`;
  }
  return Array.from(providerIds, (id) => providerNames.get(id) ?? id).join(', ');
}

export function describeActiveFilters(
  filters: CatalogFilters,
  providerNames: ReadonlyMap<string, string>
): readonly CatalogFilterChip[] {
  const chips: CatalogFilterChip[] = [];
  const query = filters.query.trim();
  if (query) {
    chips.push({ key: 'query', label: `"${query}"` });
  }
  if (filters.status !== 'all') {
    chips.push({ key: 'status', label: filters.status === 'enabled' ? 'Enabled' : 'Disabled' });
  }
  if (filters.type !== 'all') {
    chips.push({ key: 'type', label: filters.type === 'chat' ? 'Chat' : 'Embedding' });
  }
  if (filters.vision) {
    chips.push({ key: 'vision', label: 'Vision' });
  }
  if (filters.reasoning) {
    chips.push({ key: 'reasoning', label: 'Reasoning' });
  }
  if (filters.context !== 'any') {
    chips.push({ key: 'context', label: `Context ${CONTEXT_BAND_LABELS[filters.context]}` });
  }
  if (filters.providerIds.size > 0) {
    chips.push({ key: 'providers', label: describeProviders(filters.providerIds, providerNames) });
  }
  return chips;
}

export function clearCatalogFilter(filters: CatalogFilters, key: CatalogFilterKey): CatalogFilters {
  switch (key) {
    case 'context':
      return { ...filters, context: 'any' };
    case 'providers':
      return { ...filters, providerIds: new Set<string>() };
    case 'query':
      return { ...filters, query: '' };
    case 'reasoning':
      return { ...filters, reasoning: false };
    case 'status':
      return { ...filters, status: 'all' };
    case 'type':
      return { ...filters, type: 'all' };
    case 'vision':
      return { ...filters, vision: false };
    default: {
      const exhaustive: never = key;
      throw new Error(`Unknown catalog filter: ${String(exhaustive)}`);
    }
  }
}

/**
 * True when a query word hits the model id but not the display name: the row
 * then shows its id instead of its tagline (design §4, "id on demand").
 */
export function queryHitsIdOnly(row: Pick<CatalogRow, 'id' | 'name'>, query: string): boolean {
  const name = row.name.toLowerCase();
  const id = row.id.toLowerCase();
  return queryWords(query).some((word) => id.includes(word) && !name.includes(word));
}

export interface HighlightSegment {
  readonly match: boolean;
  /** Offset into the source text; unique per segment, so it doubles as a React key. */
  readonly start: number;
  readonly text: string;
}

export function highlightSegments(text: string, query: string): readonly HighlightSegment[] {
  const words = queryWords(query);
  if (words.length === 0 || text.length === 0) {
    return [{ match: false, start: 0, text }];
  }
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const word of words) {
    let from = lower.indexOf(word);
    while (from !== -1) {
      marked.fill(true, from, from + word.length);
      from = lower.indexOf(word, from + 1);
    }
  }
  const segments: HighlightSegment[] = [];
  let start = 0;
  for (let index = 1; index <= text.length; index += 1) {
    if (index === text.length || marked[index] !== marked[start]) {
      segments.push({ match: marked[start] === true, start, text: text.slice(start, index) });
      start = index;
    }
  }
  return segments;
}
