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
import { FileText, HelpCircle, Pencil, Plus, RefreshCw, Settings2 } from 'lucide-react';
import type { ComponentProps, ReactElement } from 'react';
import type { useCollectionDialogs } from '../hooks/use-collection-dialogs';
import type { useExportHandlers } from '../hooks/use-export-handlers';
import type { useImportSettings } from '../hooks/use-import-settings';
import type { EnhancedImportProgress } from '../types';
import type { UseImportFlowResult } from '../use-import-flow';
import { ExportDropdown } from './export-dropdown';
import { ImportProgressBar } from './import-progress-bar';
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
  readonly importFlow: UseImportFlowResult;
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
  importFlow,
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
  return (
    <div className="flex h-full flex-col overflow-hidden bg-panel-surface">
      <div
        className="@container/database-toolbar h-9 flex-shrink-0 border-b bg-background"
        data-testid="database-panel-toolbar"
      >
        <div className="flex h-full items-center justify-between @[360px]:gap-2 gap-1 @[360px]:px-4 px-2">
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

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button className="size-7 p-0" size="sm" variant="ghost">
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                    <span className="sr-only">Help</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[300px]" side="bottom">
                  <p className="text-sm">
                    Collections let you search files with different AI models. Create separate
                    collections for code, documentation, or general content to get better search
                    results optimized for each use case.
                  </p>
                </TooltipContent>
              </Tooltip>

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

      {importFlow.showImportProgress && importFlow.progress && (
        <ImportProgressBar
          isCancelling={importFlow.isCancelling}
          onCancel={importFlow.handleCancelImport}
          onClose={() => importFlow.setShowImportProgress(false)}
          progress={importFlow.progress as EnhancedImportProgress}
        />
      )}

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

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={`Import (${importFlow.selectedFileCount})`}
                  className="flex h-7 @[420px]:min-w-[5.25rem] items-center gap-1.5 @[420px]:px-3 px-2"
                  disabled={
                    importFlow.isImporting ||
                    !activeCollectionId ||
                    importFlow.selectedFileCount === 0 ||
                    isManagedCollection
                  }
                  onClick={importFlow.handleImportClick}
                  size="sm"
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span className="@[420px]:inline hidden font-medium">Import</span>
                  <span className="@[520px]:inline hidden text-[10px] opacity-70">
                    ({importFlow.selectedFileCount})
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {importFlow.selectedFileCount === 0
                  ? 'Select files to import first'
                  : isManagedCollection
                    ? 'Background indexing manages imports for this collection'
                    : activeCollectionId
                      ? `Import ${importFlow.selectedFileCount} files to collection`
                      : 'Select a collection first'}
              </TooltipContent>
            </Tooltip>

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
