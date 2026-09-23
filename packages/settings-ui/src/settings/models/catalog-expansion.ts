import type { CatalogProviderStat } from './catalog-sections';

/**
 * Model Catalog section expansion (BST-1805 design §3.3). Component state only:
 * persisting it would need factory-reset wiring (platform-contracts.md).
 */
export interface CatalogExpansionState {
  /** The user's expansion set; `null` until seeded from the first non-empty catalog. */
  readonly manual: ReadonlySet<string> | null;
  /** Sections collapsed during the CURRENT filter session; `null` outside a session. */
  readonly sessionCollapsed: ReadonlySet<string> | null;
}

export const INITIAL_CATALOG_EXPANSION: CatalogExpansionState = {
  manual: null,
  sessionCollapsed: null,
};

const NO_SECTIONS: ReadonlySet<string> = new Set<string>();

export function defaultManualExpansion(
  stats: readonly Pick<CatalogProviderStat, 'enabledCount' | 'providerId'>[]
): ReadonlySet<string> {
  const withEnabled = stats.filter((stat) => stat.enabledCount > 0).map((stat) => stat.providerId);
  if (withEnabled.length > 0) {
    return new Set(withEnabled);
  }
  const first = stats[0];
  return first ? new Set([first.providerId]) : NO_SECTIONS;
}

/**
 * Seeds the manual set once and opens/closes filter sessions. Returns the SAME
 * object when nothing changes, which is what lets `useCatalogExpansion` adjust
 * state during render and converge.
 */
export function reconcileCatalogExpansion(
  state: CatalogExpansionState,
  stats: readonly Pick<CatalogProviderStat, 'enabledCount' | 'providerId'>[],
  filtering: boolean
): CatalogExpansionState {
  const needsSeed = state.manual === null && stats.length > 0;
  const needsSessionStart = filtering && state.sessionCollapsed === null;
  const needsSessionEnd = !filtering && state.sessionCollapsed !== null;
  if (!(needsSeed || needsSessionStart || needsSessionEnd)) {
    return state;
  }
  let sessionCollapsed: ReadonlySet<string> | null = null;
  if (filtering) {
    sessionCollapsed = state.sessionCollapsed ?? new Set<string>();
  }
  return {
    manual: needsSeed ? defaultManualExpansion(stats) : state.manual,
    sessionCollapsed,
  };
}

export function resolveExpandedSections(
  state: CatalogExpansionState,
  visibleSectionIds: readonly string[],
  filtering: boolean
): ReadonlySet<string> {
  if (!filtering) {
    return state.manual ?? NO_SECTIONS;
  }
  const collapsed = state.sessionCollapsed ?? NO_SECTIONS;
  return new Set(visibleSectionIds.filter((id) => !collapsed.has(id)));
}

function withToggled(set: ReadonlySet<string> | null, id: string): ReadonlySet<string> {
  const next = new Set(set ?? NO_SECTIONS);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export function toggleCatalogSection(
  state: CatalogExpansionState,
  providerId: string,
  filtering: boolean
): CatalogExpansionState {
  return filtering
    ? { ...state, sessionCollapsed: withToggled(state.sessionCollapsed, providerId) }
    : { ...state, manual: withToggled(state.manual, providerId) };
}

export function expandAllCatalogSections(
  state: CatalogExpansionState,
  sectionIds: readonly string[],
  filtering: boolean
): CatalogExpansionState {
  // No sections yet (models still loading): nothing to act on. Writing an empty
  // manual set here would pre-empt the one-time seed and latch every section shut.
  if (sectionIds.length === 0) {
    return state;
  }
  return filtering
    ? { ...state, sessionCollapsed: new Set<string>() }
    : { ...state, manual: new Set(sectionIds) };
}

export function collapseAllCatalogSections(
  state: CatalogExpansionState,
  sectionIds: readonly string[],
  filtering: boolean
): CatalogExpansionState {
  // No sections yet (models still loading): nothing to act on. Writing an empty
  // manual set here would pre-empt the one-time seed and latch every section shut.
  if (sectionIds.length === 0) {
    return state;
  }
  return filtering
    ? { ...state, sessionCollapsed: new Set(sectionIds) }
    : { ...state, manual: new Set<string>() };
}
