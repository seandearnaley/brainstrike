import { FileExplorerPanel } from '@brainstrike/file-explorer-ui/shell';
import type { ExplorerActiveTab } from '@brainstrike/preferences/stores/context-explorer-layout-store';
import { useContextExplorerLayoutStore } from '@brainstrike/preferences/stores/context-explorer-layout-store';
import { lazy, type ReactElement, Suspense, useCallback, useState } from 'react';
import { useWorkspaceSearchController } from './use-workspace-search-controller';

/**
 * The Search panel is code-split: its tree/executor machinery only loads once
 * the user first opens the Search tab, keeping it out of the always-mounted
 * explorer bundle.
 */
const LazyWorkspaceSearchPanel = lazy(async () => {
  const mod = await import('@brainstrike/workspace-search');
  return { default: mod.WorkspaceSearchPanel };
});

const TABS = [
  { id: 'explorer', label: 'Explorer' },
  { id: 'search', label: 'Search' },
] as const;

const TAB_BASE_CLASS =
  'flex-1 border-transparent border-b-2 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const TAB_ACTIVE_CLASS = 'border-primary font-medium text-foreground';
const TAB_INACTIVE_CLASS = 'text-muted-foreground hover:text-foreground';

/**
 * The Search tab's live content. Instantiating the controller (which resolves
 * the embedder + model registry) is deferred to this component so it runs ONLY
 * once Search is first activated — never on the always-mounted explorer render.
 */
function WorkspaceSearchTabContent(): ReactElement {
  const controller = useWorkspaceSearchController();
  return (
    <Suspense fallback={<div className="p-3 text-muted-foreground text-sm">Loading search…</div>}>
      <LazyWorkspaceSearchPanel
        onOpenFile={controller.onOpenFile}
        resolveAdapterRootId={controller.resolveAdapterRootId}
        runSemanticSearch={controller.runSemanticSearch}
        runTextSearch={controller.runTextSearch}
        workspaceDbRootIds={controller.workspaceDbRootIds}
      />
    </Suspense>
  );
}

/**
 * The left workspace panel: an Explorer|Search tab strip. The Explorer
 * (file tree) STAYS MOUNTED when Search is active so its tree state survives
 * tab switches (only toggled hidden — mirrors RootLayoutContent's mountedTabs
 * pattern). The Search panel lazy-mounts on first activation and then stays
 * mounted too, preserving its query/results.
 */
export function ExplorerSearchTabs(): ReactElement {
  const activeTab = useContextExplorerLayoutStore((state) => state.explorerActiveTab);
  const setExplorerActiveTab = useContextExplorerLayoutStore((state) => state.setExplorerActiveTab);

  // Mounted-once latch: the Search panel mounts the first time it becomes active
  // and never unmounts afterwards. `explorerActiveTab` is only ever changed by
  // this component's tabs, so latching in the click handler (plus the lazy init
  // for a persisted `search`) covers every path — no sync effect needed.
  const [searchEverActivated, setSearchEverActivated] = useState(activeTab === 'search');
  const handleSelectTab = useCallback(
    (tab: ExplorerActiveTab): void => {
      if (tab === 'search') {
        setSearchEverActivated(true);
      }
      setExplorerActiveTab(tab);
    },
    [setExplorerActiveTab]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        aria-label="Explorer and search"
        className="flex shrink-0 border-border border-b"
        role="tablist"
      >
        {TABS.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              aria-controls={`explorer-search-panel-${tab.id}`}
              aria-selected={selected}
              className={`${TAB_BASE_CLASS} ${selected ? TAB_ACTIVE_CLASS : TAB_INACTIVE_CLASS}`}
              id={`explorer-search-tab-${tab.id}`}
              key={tab.id}
              onClick={() => handleSelectTab(tab.id)}
              role="tab"
              type="button"
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        aria-hidden={activeTab !== 'explorer'}
        aria-labelledby="explorer-search-tab-explorer"
        className={activeTab === 'explorer' ? 'min-h-0 flex-1' : 'hidden'}
        data-testid="explorer-search-panel-explorer"
        id="explorer-search-panel-explorer"
        role="tabpanel"
      >
        <FileExplorerPanel />
      </div>

      <div
        aria-hidden={activeTab !== 'search'}
        aria-labelledby="explorer-search-tab-search"
        className={activeTab === 'search' ? 'min-h-0 flex-1' : 'hidden'}
        data-testid="explorer-search-panel-search"
        id="explorer-search-panel-search"
        role="tabpanel"
      >
        {searchEverActivated ? <WorkspaceSearchTabContent /> : null}
      </div>
    </div>
  );
}
