import type { useClearAllData, usePGliteDatabase } from '@brainstrike/db/react';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import {
  EmbeddingActionsDropdown,
  type useEmbeddingControls,
} from '@brainstrike/vector-management';
import { HelpCircle, Pencil, Plus, RefreshCw, Settings2 } from 'lucide-react';
import { type ComponentProps, type ReactElement, useId, useState } from 'react';
import type { useCollectionDialogs } from '../hooks/use-collection-dialogs';
import type { useExportHandlers } from '../hooks/use-export-handlers';
import type { useImportSettings } from '../hooks/use-import-settings';
import { ExportDropdown } from './export-dropdown';
import { SearchCollectionSelector } from './search-collection-selector';
import { SettingsPanel } from './settings-panel';

interface DatabaseDemoPrimaryPanelProps {
  readonly activeCollectionCounts: ComponentProps<typeof ExportDropdown>['counts'];
  readonly activeCollectionCountsPending: boolean;
  readonly activeCollectionId: string | null;
  readonly clearAllData: ReturnType<typeof useClearAllData>;
  readonly clearing: boolean;
  readonly collectionCountsStatus: NonNullable<
    ComponentProps<typeof ExportDropdown>['countsStatus']
  >;
  readonly collectionDialogs: Pick<
    ReturnType<typeof useCollectionDialogs>,
    'handleCreateCollection' | 'handleDeleteCollection' | 'handleEditCollection'
  >;
  readonly dbContext: ReturnType<typeof usePGliteDatabase>;
  readonly dropdownProps: ReturnType<typeof useEmbeddingControls>['dropdownProps'];
  readonly exportHandlers: ReturnType<typeof useExportHandlers>;
  readonly importSettings: ReturnType<typeof useImportSettings>;
  readonly isManagedCollection: boolean;
  readonly onClearDatabase: () => Promise<void>;
  readonly onCollectionChange: (collectionId: string | null) => void;
  readonly onManualRefresh: () => void;
  readonly refreshing: boolean;
  readonly setShowClearDialog: (show: boolean) => void;
  readonly setShowSettings: (show: boolean) => void;
  readonly showClearDialog: boolean;
  readonly showSettings: boolean;
}

export function DatabaseDemoPrimaryPanel({
  activeCollectionCounts,
  activeCollectionCountsPending,
  activeCollectionId,
  clearing,
  clearAllData,
  collectionCountsStatus,
  collectionDialogs,
  dbContext,
  dropdownProps,
  exportHandlers,
  importSettings,
  isManagedCollection,
  onClearDatabase,
  onCollectionChange,
  onManualRefresh,
  refreshing,
  setShowClearDialog,
  setShowSettings,
  showClearDialog,
  showSettings,
}: DatabaseDemoPrimaryPanelProps): ReactElement {
  const [helpOpen, setHelpOpen] = useState(false);
  const helpTitleId = useId();
  return (
    <div className="flex h-full flex-col overflow-hidden bg-panel-surface">
      <div
        className="@container/database-toolbar h-9 flex-shrink-0 border-b bg-background"
        data-testid="database-panel-toolbar"
      >
        <div className="flex h-full items-center justify-between @[360px]:gap-2 gap-1 @[360px]:px-4 px-2">
          <div className="flex min-w-0 items-center">
            <Button
              aria-label="New"
              className="h-7 gap-1.5 @[360px]:px-2.5 px-2 font-medium text-xs"
              onClick={collectionDialogs.handleCreateCollection}
              size="sm"
              title="Create new collection"
              variant="ghost"
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="@[360px]:inline hidden">New</span>
            </Button>
          </div>

          <div className="flex min-w-0 items-center @[360px]:gap-2 gap-1">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    className="size-7 p-0"
                    disabled={refreshing}
                    onClick={onManualRefresh}
                    size="sm"
                    variant="ghost"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
                    />
                    <span className="sr-only">Refresh</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Refresh database records</TooltipContent>
              </Tooltip>

              {/* BST-524: Help opens on click, so its text is reachable by keyboard
                  and touch rather than only on hover. */}
              <Popover onOpenChange={setHelpOpen} open={helpOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button className="size-7 p-0" size="sm" variant="ghost">
                        <HelpCircle className="h-4 w-4 text-muted-foreground" />
                        <span className="sr-only">Help</span>
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  {!helpOpen && <TooltipContent side="bottom">About collections</TooltipContent>}
                </Tooltip>
                <PopoverContent
                  align="end"
                  aria-labelledby={helpTitleId}
                  className="w-[300px] space-y-1"
                  data-testid="database-panel-help"
                  side="bottom"
                >
                  <h3 className="font-medium text-sm" id={helpTitleId}>
                    Collections
                  </h3>
                  <p className="text-muted-foreground text-sm">
                    Collections let you search files with different AI models. Create separate
                    collections for code, documentation, or general content to get better search
                    results optimized for each use case.
                  </p>
                </PopoverContent>
              </Popover>

              <div
                className="mx-1 @[420px]:block hidden h-4 w-px bg-border"
                data-testid="database-toolbar-divider"
              />

              <Popover onOpenChange={setShowSettings} open={showSettings}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <button
                        aria-label="Import Settings"
                        className="group flex h-7 items-center gap-1.5 rounded-md border border-border bg-background @[360px]:px-2.5 px-2 text-xs transition-colors hover:border-accent-foreground/20 hover:bg-accent focus-visible:border-foreground/20 focus-visible:bg-accent/80 focus-visible:outline-none motion-reduce:transition-none"
                        type="button"
                      >
                        <Settings2 className="size-3.5 text-muted-foreground" />
                        <span className="@[360px]:inline hidden font-medium">Settings</span>
                        <Pencil className="@[440px]:block hidden size-3 text-muted-foreground" />
                      </button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  {!showSettings && (
                    <TooltipContent side="bottom">
                      <div className="text-xs">Configure import and chunking</div>
                    </TooltipContent>
                  )}
                </Tooltip>
                <PopoverContent
                  align="end"
                  className="w-[min(96vw,48rem)] max-w-[calc(100vw-1.5rem)] p-0"
                  collisionPadding={16}
                  side="bottom"
                >
                  <SettingsPanel
                    className="mt-0 border-none bg-transparent"
                    clearDatabaseProps={{
                      chunksCount: activeCollectionCounts.chunks,
                      clearAllData,
                      clearing,
                      countsPending: activeCollectionCountsPending,
                      onClear: onClearDatabase,
                      recordsCount: activeCollectionCounts.records,
                      setShowClearDialog,
                      showClearDialog,
                    }}
                    importSettings={importSettings}
                  />
                </PopoverContent>
              </Popover>
            </TooltipProvider>
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-3">
        <SearchCollectionSelector
          activeCollectionId={activeCollectionId}
          db={dbContext}
          onCollectionChange={onCollectionChange}
          onCreateCollection={collectionDialogs.handleCreateCollection}
          onDeleteCollection={collectionDialogs.handleDeleteCollection}
          onEditCollection={collectionDialogs.handleEditCollection}
        />
        {isManagedCollection ? (
          <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-primary text-xs">
            This collection is managed by background indexing. Manual DB imports are disabled so the
            root-folder cache stays canonical.
          </div>
        ) : null}
      </div>

      {/* Import progress renders next to the trigger, in the explorer's
          selection action bar (BST-1212). */}
      <div
        className="@container/database-actions flex-shrink-0 border-t bg-background"
        data-testid="database-panel-actions"
      >
        <div
          className="flex h-9 flex-nowrap items-center justify-center @[420px]:gap-2 gap-1 @[420px]:px-4 px-1"
          data-testid="database-panel-actions-row"
        >
          <TooltipProvider delayDuration={200}>
            <ExportDropdown
              collapseLabelAtNarrowWidth
              counts={activeCollectionCounts}
              countsStatus={collectionCountsStatus}
              exportHandlers={exportHandlers}
            />

            {/* Importing is triggered from the file explorer's selection
                action bar (BST-1212) — the surface that owns the selection.
                There is deliberately no second entry point here. */}

            <EmbeddingActionsDropdown
              {...dropdownProps}
              className="shrink-0"
              collapseLabelAtNarrowWidth
            />
          </TooltipProvider>
        </div>
      </div>
    </div>
  );
}
