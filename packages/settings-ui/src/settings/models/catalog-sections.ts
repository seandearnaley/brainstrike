import { isLocalModelProviderId } from '@brainstrike/app-state/models/local-model-utils';
import type { DbProvider } from '@brainstrike/app-state/stores/model-registry-store';
import {
  findProviderDefinition,
  type ProviderRuntime,
} from '@brainstrike/assistant-contract/provider-registry';
import {
  type CatalogFilters,
  isCatalogFilterActive,
  matchesCatalogFilters,
} from './catalog-filters';
import type { CatalogRow } from './catalog-projection';

/** Section id for models whose provider row is missing (kept visible, never dropped). */
export const UNKNOWN_PROVIDER_SECTION_ID = '__unknown-provider__';
export const UNKNOWN_PROVIDER_NAME = 'Unknown provider';

export type CatalogSortColumn = 'context' | 'maxOutput' | 'name' | 'price';

export interface CatalogSort {
  readonly column: CatalogSortColumn;
  readonly direction: 'asc' | 'desc';
}

export interface CatalogProviderStat {
  /** Enabled models of this provider, over ALL its rows (never filtered). */
  readonly enabledCount: number;
  readonly providerId: string;
  readonly providerName: string;
  readonly totalCount: number;
}

export interface CatalogSection extends CatalogProviderStat {
  /** Matching rows in display order: catalog order unless a column sort is active. */
  readonly rows: readonly CatalogRow[];
  readonly runtimeLabel: string | null;
}

export interface CatalogSummary {
  readonly enabledModels: number;
  readonly filtering: boolean;
  readonly matchingModels: number;
  readonly matchingProviders: number;
  readonly totalModels: number;
  readonly totalProviders: number;
}

export interface CatalogView {
  /** Every provider that has at least one model, in DB order, with unfiltered counts. */
  readonly providerStats: readonly CatalogProviderStat[];
  /** Providers with at least one matching row. */
  readonly sections: readonly CatalogSection[];
  readonly summary: CatalogSummary;
}

const RUNTIME_LABELS: Record<ProviderRuntime, string> = {
  browser: 'On device',
  gateway: 'Gateway',
  hosted: 'Hosted',
  local: 'Local server',
};

function resolveRuntimeLabel(providerId: string): string | null {
  const definition = findProviderDefinition(providerId);
  if (definition) {
    return RUNTIME_LABELS[definition.runtime];
  }
  // DB-only providers (`transformers`) are classified by the canonical local
  // classifier rather than guessed.
  return isLocalModelProviderId(providerId) ? 'On device' : null;
}

function sortValue(row: CatalogRow, column: CatalogSortColumn): number | string | null {
  switch (column) {
    case 'context':
      return row.contextWindow;
    case 'maxOutput':
      return row.maxOutputTokens;
    case 'name':
      return row.name;
    case 'price':
      return row.pricing?.inputPerMTok ?? null;
    default: {
      const exhaustive: never = column;
      throw new Error(`Unknown catalog sort column: ${String(exhaustive)}`);
    }
  }
}

function compareValues(left: number | string, right: number | string): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/**
 * Caller-owned sort within ONE section (TreeGrid sorting contract): values are
 * read once per row, absent values sort last in BOTH directions, and ties keep
 * catalog order.
 */
export function sortCatalogRows(
  rows: readonly CatalogRow[],
  sort: CatalogSort | null
): readonly CatalogRow[] {
  if (!sort) {
    return rows;
  }
  const direction = sort.direction === 'asc' ? 1 : -1;
  const keyed = rows.map((row, index) => ({ index, row, value: sortValue(row, sort.column) }));
  keyed.sort((left, right) => {
    if (left.value === null || right.value === null) {
      if (left.value === right.value) {
        return left.index - right.index;
      }
      return left.value === null ? 1 : -1;
    }
    const order = compareValues(left.value, right.value) * direction;
    return order === 0 ? left.index - right.index : order;
  });
  return keyed.map((entry) => entry.row);
}

export function buildCatalogView({
  filters,
  providers,
  rows,
  sort,
}: {
  readonly filters: CatalogFilters;
  readonly providers: readonly DbProvider[];
  readonly rows: readonly CatalogRow[];
  readonly sort: CatalogSort | null;
}): CatalogView {
  const knownProviderIds = new Set(providers.map((provider) => provider.id));
  const rowsByProvider = new Map<string, CatalogRow[]>();
  for (const row of rows) {
    const key = knownProviderIds.has(row.providerId) ? row.providerId : UNKNOWN_PROVIDER_SECTION_ID;
    const bucket = rowsByProvider.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      rowsByProvider.set(key, [row]);
    }
  }

  const orderedProviders = [
    ...providers.map((provider) => ({ id: provider.id, name: provider.name })),
    { id: UNKNOWN_PROVIDER_SECTION_ID, name: UNKNOWN_PROVIDER_NAME },
  ];
  const providerStats: CatalogProviderStat[] = [];
  const sections: CatalogSection[] = [];
  for (const provider of orderedProviders) {
    const providerRows = rowsByProvider.get(provider.id);
    if (!providerRows) {
      continue;
    }
    const stat: CatalogProviderStat = {
      enabledCount: providerRows.filter((row) => row.enabled).length,
      providerId: provider.id,
      providerName: provider.name,
      totalCount: providerRows.length,
    };
    providerStats.push(stat);
    if (filters.providerIds.size > 0 && !filters.providerIds.has(provider.id)) {
      continue;
    }
    const matching = providerRows.filter((row) => matchesCatalogFilters(row, filters));
    if (matching.length === 0) {
      continue;
    }
    sections.push({
      ...stat,
      rows: sortCatalogRows(matching, sort),
      runtimeLabel:
        provider.id === UNKNOWN_PROVIDER_SECTION_ID ? null : resolveRuntimeLabel(provider.id),
    });
  }

  return {
    providerStats,
    sections,
    summary: {
      enabledModels: rows.filter((row) => row.enabled).length,
      filtering: isCatalogFilterActive(filters),
      matchingModels: sections.reduce((total, section) => total + section.rows.length, 0),
      matchingProviders: sections.length,
      totalModels: rows.length,
      totalProviders: providerStats.length,
    },
  };
}
