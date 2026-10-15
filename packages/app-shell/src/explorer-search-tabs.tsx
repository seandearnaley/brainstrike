import type { ExplorerActiveTab } from '@brainstrike/app-state/stores/context-explorer-layout-store';
import { useContextExplorerLayoutStore } from '@brainstrike/app-state/stores/context-explorer-layout-store';
import { hasDurableAssistantUsageCapability } from '@brainstrike/assistant-data';
import {
  ExplorerContextExportAction,
  FileExplorerPanel,
} from '@brainstrike/file-explorer-ui/shell';
import type { QueueAdapter } from '@brainstrike/queue';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@brainstrike/ui';
import { lazy, type ReactElement, Suspense, useCallback, useMemo } from 'react';
import { ExplorerAttachAction } from './explorer-attach-action';
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
        allowTextPaging={controller.allowTextPaging}
        onOpenFile={controller.onOpenFile}
        resolveAdapterRootId={controller.resolveAdapterRootId}
        runSemanticSearch={controller.runSemanticSearch}
        runTextSearch={controller.runTextSearch}
        {...(controller.semanticAvailability === undefined
          ? {}
          : { semanticAvailability: controller.semanticAvailability })}
        workspaceDbRootIds={controller.workspaceDbRootIds}
      />
    </Suspense>
  );
}

/**
 * The left workspace panel: an Explorer|Search switcher on the shared `sm`
 * Tabs, the same idiom as the Library. Both panels are `keepMounted`: the
 * Explorer (file tree) mounts at once and survives Search being active, and
 * the code-split Search panel mounts on first activation, then keeps its
 * query and results. Manual activation (the Tabs default) means keyboard
 * roving never downloads Search. The value lives in a zustand store, whose
 * updates always render synchronously, so the switch uses no transition.
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

  const handleValueChange = useCallback(
    (value: string): void => {
      if (isExplorerActiveTab(value)) {
        setExplorerActiveTab(value);
      }
    },
    [setExplorerActiveTab]
  );

  // FileExplorerPanelInner is memoized; a fresh element identity here would
  // re-render the whole tree panel on every tab switch.
  // "Attach to thread" needs the desktop assistant host to read the mentions
  // it writes (the same capability gate as the composer's "@" picker).
  const selectionActions = useMemo(
    () => (
      <>
        {hasDurableAssistantUsageCapability() ? <ExplorerAttachAction /> : null}
        <ExplorerContextExportAction />
        <ExplorerImportActionLazy loadEmbeddingQueue={loadEmbeddingQueue} />
      </>
    ),
    [loadEmbeddingQueue]
  );
  const rootActions = useWorkspaceRootActions();

  return (
    <Tabs
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      onValueChange={handleValueChange}
      value={activeTab}
    >
      <div
        className="flex h-9 min-w-0 shrink-0 items-center border-border border-b px-2"
        data-testid="explorer-search-tab-strip"
      >
        <TabsList aria-label="Explorer and search" className="grid w-full grid-cols-2" size="sm">
          <TabsTrigger data-testid="explorer-tab-trigger" value="explorer">
            <span className="truncate">Explorer</span>
          </TabsTrigger>
          <TabsTrigger data-testid="search-tab-trigger" value="search">
            <span className="truncate">Search</span>
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent
        className="min-h-0 flex-1"
        data-testid="explorer-search-panel-explorer"
        forceMount
        value="explorer"
      >
        <FileExplorerPanel rootActions={rootActions} selectionActions={selectionActions} />
      </TabsContent>

      <TabsContent
        className="min-h-0 flex-1"
        data-testid="explorer-search-panel-search"
        keepMounted
        value="search"
      >
        <WorkspaceSearchTabContent />
      </TabsContent>
    </Tabs>
  );
}
