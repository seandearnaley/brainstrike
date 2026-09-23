import type { DbModel, DbProvider } from '@brainstrike/app-state/stores/model-registry-store';
import { Button, EmptyState, useResizeObserver } from '@brainstrike/ui';
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CatalogColumnHeader } from './catalog-column-header';
import {
  type CatalogWidthTier,
  getCatalogColumnLayout,
  getCatalogColumns,
  resolveCatalogWidthTier,
} from './catalog-columns';
import {
  type CatalogFilterKey,
  type CatalogFilters,
  clearCatalogFilter,
  DEFAULT_CATALOG_FILTERS,
  describeActiveFilters,
} from './catalog-filters';
import { createCatalogNodeCache } from './catalog-nodes';
import { createCatalogProjector } from './catalog-projection';
import { CatalogSection } from './catalog-section';
import {
  buildCatalogView,
  type CatalogProviderStat,
  type CatalogSection as CatalogSectionModel,
  type CatalogSort,
  UNKNOWN_PROVIDER_NAME,
} from './catalog-sections';
import { CatalogToolbar } from './catalog-toolbar';
import { useCatalogExpansion } from './use-catalog-expansion';
import { type CatalogRowActions, CatalogRowActionsContext } from './use-catalog-row-actions';
import type { ModelBulkChange } from './use-model-bulk-toggle';

const NO_IDS: ReadonlySet<string> = new Set<string>();
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
/** Joins section ids into one comparable key; provider ids never contain a newline. */
const SECTION_KEY_SEPARATOR = '\n';

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITABLE_SELECTOR) !== null;
}

/**
 * Drops selected provider ids that no longer name a catalog section (a
 * registry refresh can remove a provider's last model). Returns the SAME
 * object when nothing is stale, so the caller's render-time reconcile settles.
 */
function pruneProviderSelection(
  filters: CatalogFilters,
  providerStats: readonly CatalogProviderStat[]
): CatalogFilters {
  if (filters.providerIds.size === 0) {
    return filters;
  }
  const present = new Set(providerStats.map((stat) => stat.providerId));
  const kept = Array.from(filters.providerIds).filter((id) => present.has(id));
  return kept.length === filters.providerIds.size
    ? filters
    : { ...filters, providerIds: new Set(kept) };
}

export interface ModelCatalogProps {
  readonly busyModelIds: ReadonlySet<string>;
  readonly downloadedModels: Readonly<Record<string, boolean>>;
  readonly downloadProgress: Readonly<Record<string, number>>;
  readonly isDownloading: Readonly<Record<string, boolean>>;
  /** The registry has loaded at least once (distinguishes loading from empty). */
  readonly loaded: boolean;
  readonly modelCacheDir: string | null;
  readonly models: readonly DbModel[];
  readonly onBulkChange: (change: ModelBulkChange) => void;
  readonly onDownload: (modelId: string) => void;
  readonly onRefresh: () => void;
  readonly onToggle: (modelId: string, enabled: boolean) => void;
  readonly providers: readonly DbProvider[];
}

/**
 * The Model Catalog (BST-1805): toolbar, one presentational column header, and
 * ONE scroll owner holding a windowed TreeTable per expanded provider section
 * (shared-scroller mode, docs/agents/ui-conventions.md).
 */
export function ModelCatalog({
  busyModelIds,
  downloadedModels,
  downloadProgress,
  isDownloading,
  loaded,
  modelCacheDir,
  models,
  onBulkChange,
  onDownload,
  onRefresh,
  onToggle,
  providers,
}: ModelCatalogProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Container query, not a viewport media query (design §5). Until the first
  // measurement lands (one frame) the catalog lays out as wide.
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  useResizeObserver(
    rootRef,
    useCallback((entry: ResizeObserverEntry) => {
      setMeasuredWidth(entry.contentRect.width);
    }, [])
  );
  const tier: CatalogWidthTier =
    measuredWidth === null ? 'wide' : resolveCatalogWidthTier(measuredWidth);

  const [filters, setFilters] = useState<CatalogFilters>(DEFAULT_CATALOG_FILTERS);
  const deferredQuery = useDeferredValue(filters.query);
  const effectiveFilters = useMemo(
    () => ({ ...filters, query: deferredQuery }),
    [filters, deferredQuery]
  );
  const [sort, setSort] = useState<CatalogSort | null>(null);
  const [detailsOpenIds, setDetailsOpenIds] = useState<ReadonlySet<string>>(NO_IDS);
  // One projector and one node cache per catalog instance: both are keyed on
  // object identity, which is what keeps untouched rows (and their TreeNodes)
  // identical across a toggle (TreeGrid row-identity contract).
  const [project] = useState(createCatalogProjector);
  const [getNodes] = useState(createCatalogNodeCache);

  const providerNames = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.name])),
    [providers]
  );
  const rows = useMemo(
    () =>
      models.map((model) =>
        project(model, providerNames.get(model.providerId) ?? UNKNOWN_PROVIDER_NAME)
      ),
    [models, project, providerNames]
  );
  const view = useMemo(
    () => buildCatalogView({ filters: effectiveFilters, providers, rows, sort }),
    [effectiveFilters, providers, rows, sort]
  );

  // A selected provider can leave the catalog. Its id would then be unnamed,
  // and describeActiveFilters throws on an unnamed id, so the stale selection
  // is dropped here — adjusted during render, React's sanctioned alternative
  // to a syncing effect (the same pattern as useCatalogExpansion).
  const liveFilters = pruneProviderSelection(filters, view.providerStats);
  if (liveFilters !== filters) {
    setFilters(liveFilters);
  }

  const filtering = view.summary.filtering;
  // Keyed on the section ids, not on `view.sections` (a new array on every
  // toggle), so Expand all / Collapse all keep their identity while the
  // visible sections are unchanged.
  const sectionKey = view.sections.map((section) => section.providerId).join(SECTION_KEY_SEPARATOR);
  const visibleSectionIds = useMemo(
    () => (sectionKey === '' ? [] : sectionKey.split(SECTION_KEY_SEPARATOR)),
    [sectionKey]
  );
  const expansion = useCatalogExpansion({
    filtering,
    providerStats: view.providerStats,
    visibleSectionIds,
  });
  // Chip names come from providerStats: its ids are the SECTION ids the
  // Providers filter selects (including UNKNOWN_PROVIDER_SECTION_ID).
  const sectionNames = useMemo(
    () => new Map(view.providerStats.map((stat) => [stat.providerId, stat.providerName])),
    [view.providerStats]
  );
  const chips = useMemo(
    () => describeActiveFilters(liveFilters, sectionNames),
    [liveFilters, sectionNames]
  );

  const toggleDetails = useCallback((modelId: string): void => {
    setDetailsOpenIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  }, []);

  // Bulk actions only ever touch SHOWN rows, and only those that would change:
  // an unchanged row must not be written (it would gain a new updated_at, and
  // Undo would then "restore" it too).
  const handleBulk = useCallback(
    (section: CatalogSectionModel, enabled: boolean): void => {
      onBulkChange({
        enabled,
        modelIds: section.rows.filter((row) => row.enabled !== enabled).map((row) => row.id),
        scopeLabel: section.providerName,
      });
    },
    [onBulkChange]
  );

  const clearChip = useCallback((key: CatalogFilterKey): void => {
    setFilters((current) => clearCatalogFilter(current, key));
  }, []);
  const clearAll = useCallback((): void => {
    setFilters(DEFAULT_CATALOG_FILTERS);
  }, []);

  const rowActions = useMemo<CatalogRowActions>(
    () => ({
      busyModelIds,
      downloadedModels,
      downloadProgress,
      isDownloading,
      modelCacheDir,
      onDownload,
      onToggle,
      onToggleDetails: toggleDetails,
      query: deferredQuery,
      showTagline: tier !== 'narrow',
      showTypeTag: filters.type === 'all',
    }),
    [
      busyModelIds,
      deferredQuery,
      downloadedModels,
      downloadProgress,
      filters.type,
      isDownloading,
      modelCacheDir,
      onDownload,
      onToggle,
      tier,
      toggleDetails,
    ]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== '/' ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      const input = searchInputRef.current;
      // Settings is a keep-mounted shell tab: while another tab shows, this
      // catalog stays mounted under an aria-hidden route and must not steal `/`.
      if (
        !input ||
        input.closest('[aria-hidden="true"]') !== null ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      input.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const columns = getCatalogColumns(tier);
  let body: ReactNode;
  if (models.length === 0) {
    body = loaded ? (
      <EmptyState
        action={
          <Button onClick={onRefresh} size="sm" variant="outline">
            Refresh
          </Button>
        }
        data-testid="model-catalog-empty"
        description="Refresh the registry to load the catalogue."
        title="No models are catalogued yet"
      />
    ) : (
      <p className="p-6 text-muted-foreground text-sm" role="status">
        Loading models…
      </p>
    );
  } else if (view.sections.length === 0) {
    body = (
      <EmptyState
        action={
          <Button onClick={clearAll} size="sm" variant="outline">
            Clear filters
          </Button>
        }
        data-testid="model-catalog-no-matches"
        description="Try a different search or remove a filter."
        title="No models match"
      />
    );
  } else {
    body = view.sections.map((section) => (
      <CatalogSection
        busyModelIds={busyModelIds}
        columns={columns}
        compact={tier === 'narrow'}
        detailsOpenIds={detailsOpenIds}
        expanded={expansion.expandedSectionIds.has(section.providerId)}
        filtering={filtering}
        getNodes={getNodes}
        key={section.providerId}
        onBulkChange={handleBulk}
        onToggleDetails={toggleDetails}
        onToggleModel={onToggle}
        onToggleSection={expansion.toggleSection}
        scrollParentRef={scrollRef}
        section={section}
      />
    ));
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3"
      data-testid="model-catalog"
      data-width-tier={tier}
      ref={rootRef}
    >
      <CatalogToolbar
        chips={chips}
        compact={tier === 'narrow'}
        filters={liveFilters}
        onClearAll={clearAll}
        onClearChip={clearChip}
        onCollapseAll={expansion.collapseAll}
        onExpandAll={expansion.expandAll}
        onFiltersChange={setFilters}
        providerOptions={view.providerStats}
        searchInputRef={searchInputRef}
        summary={view.summary}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
        <CatalogColumnHeader
          layout={getCatalogColumnLayout(tier)}
          onSortChange={setSort}
          scrollerRef={scrollRef}
          sort={sort}
        />
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          data-testid="model-catalog-scroll"
          ref={scrollRef}
        >
          <CatalogRowActionsContext value={rowActions}>{body}</CatalogRowActionsContext>
        </div>
      </div>
    </div>
  );
}
