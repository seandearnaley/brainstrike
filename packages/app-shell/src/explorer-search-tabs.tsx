import type { ExplorerActiveTab } from '@brainstrike/app-state/stores/context-explorer-layout-store';
import { useContextExplorerLayoutStore } from '@brainstrike/app-state/stores/context-explorer-layout-store';
import { FileExplorerPanel } from '@brainstrike/file-explorer-ui/shell';
import type { QueueAdapter } from '@brainstrike/queue';
import {
  PANEL_TAB_TRIGGER_CLASS_NAME,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@brainstrike/ui';
import { lazy, type ReactElement, Suspense, useCallback, useMemo, useState } from 'react';
import { ExplorerImportActionLazy } from './explorer-import-action-lazy';
import { useWorkspaceSearchController } from './use-workspace-search-controller';
import { useWorkspaceRootActions } from './workspace-root-context-actions';

/**
 * The Search panel is code-split: its tree/executor machinery only loads once
 * the user first opens the Search tab, keeping it out of the always-mounted
 * explorer bundle.
 */
const LazyWorkspaceSearchPanel = lazy(async () => {
  const mod = await import('@brainstrike/workspace-search');
  return { default: mod.WorkspaceSearchPanel };
});

function isExplorerActiveTab(value: string): value is ExplorerActiveTab {
  return value === 'explorer' || value === 'search';
}

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
 * The left workspace panel: an Explorer|Search tab strip built on the shared
 * segmented Tabs primitive (same idiom as the Library tabs). The Explorer
 * (file tree) STAYS MOUNTED when Search is active so its tree state survives
 * tab switches (only toggled hidden — mirrors AgentSidebarPanel's forceMount
 * pattern). The Search panel lazy-mounts on first activation and then stays
 * mounted too, preserving its query/results.
 */
interface ExplorerSearchTabsProps {
  /**
   * Lazy loader for the app-owned embedding queue, forwarded to the explorer's
   * collection-import action (the queue the produced chunks are embedded on).
   */
  readonly loadEmbeddingQueue?: (() => Promise<QueueAdapter>) | null;
}

export function ExplorerSearchTabs({
  loadEmbeddingQueue = null,
}: ExplorerSearchTabsProps = {}): ReactElement {
  const activeTab = useContextExplorerLayoutStore((state) => state.explorerActiveTab);
  const setExplorerActiveTab = useContextExplorerLayoutStore((state) => state.setExplorerActiveTab);

  // Mounted-once latch: the Search panel mounts the first time it becomes active
  // and never unmounts afterwards. `explorerActiveTab` is only ever changed by
  // this component's tabs, so latching in the change handler (plus the lazy init
  // for a persisted `search`) covers every path — no sync effect needed.
  const [searchEverActivated, setSearchEverActivated] = useState(activeTab === 'search');
  const handleValueChange = useCallback(
    (value: string): void => {
      if (!isExplorerActiveTab(value)) {
        return;
      }
      if (value === 'search') {
        setSearchEverActivated(true);
      }
      setExplorerActiveTab(value);
    },
    [setExplorerActiveTab]
  );

  // FileExplorerPanelInner is memoized; a fresh element identity here would
  // re-render the whole tree panel on every tab switch.
  const importAction = useMemo(
    () => <ExplorerImportActionLazy loadEmbeddingQueue={loadEmbeddingQueue} />,
    [loadEmbeddingQueue]
  );
  const rootActions = useWorkspaceRootActions();

  const searchTabMountProps = searchEverActivated
    ? ({
        forceMount: true,
      } as const)
    : {};

  return (
    <Tabs
      // Manual activation: arrow keys move focus without activating, so
      // keyboard roving never latches (and lazily downloads) the Search panel.
      activationMode="manual"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      onValueChange={handleValueChange}
      value={activeTab}
    >
      <div
        className="flex h-9 min-w-0 shrink-0 items-center border-border border-b px-2"
        data-testid="explorer-search-tab-strip"
      >
        <TabsList aria-label="Explorer and search" className="grid h-7 w-full grid-cols-2">
          <TabsTrigger
            className={PANEL_TAB_TRIGGER_CLASS_NAME}
            data-testid="explorer-tab-trigger"
            value="explorer"
          >
            <span className="truncate">Explorer</span>
          </TabsTrigger>
          <TabsTrigger
            className={PANEL_TAB_TRIGGER_CLASS_NAME}
            data-testid="search-tab-trigger"
            value="search"
          >
            <span className="truncate">Search</span>
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent
        className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
        data-testid="explorer-search-panel-explorer"
        forceMount
        hidden={activeTab !== 'explorer'}
        value="explorer"
      >
        <FileExplorerPanel rootActions={rootActions} selectionActions={importAction} />
      </TabsContent>

      <TabsContent
        className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
        data-testid="explorer-search-panel-search"
        hidden={activeTab !== 'search'}
        {...searchTabMountProps}
        value="search"
      >
        {searchEverActivated ? <WorkspaceSearchTabContent /> : null}
      </TabsContent>
    </Tabs>
  );
}
