import { useCallback, useState } from 'react';
import {
  type CatalogExpansionState,
  collapseAllCatalogSections,
  expandAllCatalogSections,
  INITIAL_CATALOG_EXPANSION,
  reconcileCatalogExpansion,
  resolveExpandedSections,
  toggleCatalogSection,
} from './catalog-expansion';
import type { CatalogProviderStat } from './catalog-sections';

export interface CatalogExpansionController {
  readonly collapseAll: () => void;
  readonly expandAll: () => void;
  readonly expandedSectionIds: ReadonlySet<string>;
  readonly toggleSection: (providerId: string) => void;
}

export function useCatalogExpansion({
  filtering,
  providerStats,
  visibleSectionIds,
}: {
  readonly filtering: boolean;
  readonly providerStats: readonly CatalogProviderStat[];
  readonly visibleSectionIds: readonly string[];
}): CatalogExpansionController {
  const [stored, setStored] = useState<CatalogExpansionState>(INITIAL_CATALOG_EXPANSION);
  // Derived state adjusted DURING RENDER — React's sanctioned alternative to a
  // syncing effect (react-hooks/set-state-in-effect). `reconcile` returns the
  // same object once settled, so this converges in one extra render.
  const state = reconcileCatalogExpansion(stored, providerStats, filtering);
  if (state !== stored) {
    setStored(state);
  }

  const toggleSection = useCallback(
    (providerId: string): void => {
      setStored((previous) => toggleCatalogSection(previous, providerId, filtering));
    },
    [filtering]
  );
  const expandAll = useCallback((): void => {
    setStored((previous) => expandAllCatalogSections(previous, visibleSectionIds, filtering));
  }, [filtering, visibleSectionIds]);
  const collapseAll = useCallback((): void => {
    setStored((previous) => collapseAllCatalogSections(previous, visibleSectionIds, filtering));
  }, [filtering, visibleSectionIds]);

  return {
    collapseAll,
    expandAll,
    expandedSectionIds: resolveExpandedSections(state, visibleSectionIds, filtering),
    toggleSection,
  };
}
