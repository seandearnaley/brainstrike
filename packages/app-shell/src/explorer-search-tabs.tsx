import type { ExplorerActiveTab } from '@brainstrike/app-state/stores/context-explorer-layout-store';
import { useContextExplorerLayoutStore } from '@brainstrike/app-state/stores/context-explorer-layout-store';
import { hasDurableAssistantUsageCapability } from '@brainstrike/assistant-data';
import {
  ExplorerContextExportAction,
  FileExplorerPanel,
} from '@brainstrike/file-explorer-ui/shell';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@brainstrike/ui';
import { lazy, type ReactElement, Suspense } from 'react';
import { ExplorerThreadStatusProvider } from './context-map/explorer-thread-status-provider';
import { ExplorerAttachAction } from './explorer-attach-action';
import { useAttachFilesToThread } from './use-attach-files-to-thread';
import { useSearchSelectionBridge } from './use-search-selection-bridge';
import { useWorkspaceSearchController } from './use-workspace-search-controller';
import { useWorkspaceRootActions } from './workspace-root-context-actions';

/**
 * The Search panel is code-split: its tree machinery only loads once
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
 * The Search tab's live content. Instantiating the controller is deferred to
 * this component so it runs ONLY once Search is first activated, never on the
 * always-mounted explorer render.
 */
function WorkspaceSearchTabContent(): ReactElement {
  const controller = useWorkspaceSearchController();
  const attachFiles = useAttachFilesToThread();
  // Result checkboxes drive the explorer's own selection store.
  const selection = useSearchSelectionBridge();
  const onAttachFile = (fileKey: string) => attachFiles([fileKey], 1);
  return (
    <Suspense fallback={<div className="text-muted-foreground p-3 text-sm">Loading search…</div>}>
      <LazyWorkspaceSearchPanel
        // A result file attaches like the selection bar's Attach: desktop host threads read mentions.
        {...(hasDurableAssistantUsageCapability() ? { onAttachFile } : {})}
        onOpenFile={controller.onOpenFile}
        rootName={controller.rootName}
        runSearch={controller.runSearch}
        selection={selection}
        workspaceRootCount={controller.workspaceRootCount}
      />
    </Suspense>
  );
}

/**
 * The left workspace panel: an Explorer|Search switcher on the shared `sm`
 * Tabs. Both panels are `keepMounted`: the
 * Explorer (file tree) mounts at once and survives Search being active, and
 * the code-split Search panel mounts on first activation, then keeps its
 * query and results. Manual activation (the Tabs default) means keyboard
 * roving never downloads Search. The value lives in a zustand store, whose
 * updates always render synchronously, so the switch uses no transition.
 */
export function ExplorerSearchTabs(): ReactElement {
  const activeTab = useContextExplorerLayoutStore((state) => state.explorerActiveTab);
  const setExplorerActiveTab = useContextExplorerLayoutStore((state) => state.setExplorerActiveTab);

  const handleValueChange = (value: string): void => {
    if (isExplorerActiveTab(value)) {
      setExplorerActiveTab(value);
    }
  };

  // FileExplorerPanelInner is memoized; a fresh element identity here would
  // re-render the whole tree panel on every tab switch.
  // "Attach to thread" needs the desktop assistant host to read the mentions
  // it writes.
  const selectionActions = (
    <>
      {hasDurableAssistantUsageCapability() ? <ExplorerAttachAction /> : null}
      <ExplorerContextExportAction />
    </>
  );
  const rootActions = useWorkspaceRootActions();
  const explorer = (
    <FileExplorerPanel rootActions={rootActions} selectionActions={selectionActions} />
  );

  return (
    <Tabs
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      onValueChange={handleValueChange}
      value={activeTab}
    >
      <div
        className="border-border flex h-9 min-w-0 shrink-0 items-center border-b px-2"
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
        {/* The "This thread" column reads the desktop host's committed thread log. */}
        {hasDurableAssistantUsageCapability() ? (
          <ExplorerThreadStatusProvider>{explorer}</ExplorerThreadStatusProvider>
        ) : (
          explorer
        )}
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
