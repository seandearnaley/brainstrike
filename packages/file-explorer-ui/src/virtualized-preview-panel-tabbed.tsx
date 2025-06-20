import { Badge, Button, Checkbox, Progress } from '@brainstrike/ui';
import { ArrowDown, ArrowUp, FileX2 } from 'lucide-react';
import { memo, useState } from 'react';
import { formatTokenCount, usePreviewPanelState } from './use-preview-panel-state';
import { VirtualizedPreviewList } from './virtualized-preview-list';

interface VirtualizedPreviewPanelTabbedProps {
  selectedFiles: Set<string>;
  fileContents: { [compositeKey: string]: string };
  loadingFiles: Set<string>;
  onSelectionChange: (files: Set<string>) => void;
  fileSizes?: { [compositeKey: string]: number };
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
  countTokensHeuristic: (content: string) => number;
  estimateTokenCost?: (tokens: number) => number;
  performUndoableAction: (
    key: string,
    itemKey: string,
    opts: {
      actionName: string;
      itemDescription: string;
      getStateSnapshot: () => Set<string>;
      onUndo: (key: string, snapshot: Set<string>) => void;
    }
  ) => void;
  onFileClick?: (compositeKey: string) => void;
}

export const VirtualizedPreviewPanelTabbed = memo<VirtualizedPreviewPanelTabbedProps>(
  function VirtualizedPreviewPanelTabbedComponent(props) {
    const {
      selectedFiles,
      fileContents,
      loadingFiles,
      onSelectionChange,
      fileSizes,
      decodeFileSelection,
      countTokensHeuristic,
      performUndoableAction,
      onFileClick,
    } = props;

    const [announcement, setAnnouncement] = useState('');
    const [lastAnnouncedFolder, setLastAnnouncedFolder] = useState<string | null>(null);

    const state = usePreviewPanelState({
      selectedFiles,
      fileContents,
      loadingFiles,
      onSelectionChange,
      ...(fileSizes ? { fileSizes } : {}),
      decodeFileSelection,
      countTokensHeuristic,
      performUndoableAction,
    });

    const {
      batchSelectedFiles,
      totalStats,
      expandAllFolders,
      collapseAllFolders,
      handleSelectAll,
      handleDeselectAll,
      isAllFilesSelected,
      handleBatchRemove,
      toggleFolderCollapse,
    } = state;

    const handleFolderToggle = (folderId: string) => {
      toggleFolderCollapse(folderId);
      setAnnouncement(
        `${state.collapsedFolders.has(folderId) ? 'Expanded' : 'Collapsed'} folder ${folderId}`
      );
      setLastAnnouncedFolder(folderId);
    };

    if (selectedFiles.size === 0) {
      return (
        <div className="p-4">
          <p className="text-sm text-gray-500">No files selected</p>
        </div>
      );
    }

    const listState = { ...state, toggleFolderCollapse: handleFolderToggle } as typeof state;

    return (
      <div className="h-full flex">
        <div className="flex-1 flex flex-col">
          <div className="p-3 border-b flex items-center justify-between bg-background">
            <div className="flex items-center gap-3">
              <Checkbox
                checked={isAllFilesSelected}
                onCheckedChange={(checked) => (checked ? handleSelectAll() : handleDeselectAll())}
                className="flex-shrink-0"
              />
              <Badge variant="outline" className="py-1.5">
                {formatTokenCount(totalStats.totalTokens)}
              </Badge>
              <div className="text-xs text-muted-foreground">
                <span className="font-medium">{totalStats.totalFiles}</span> files |{' '}
                <span className="font-medium">{totalStats.totalTokens.toLocaleString()}</span>{' '}
                tokens
              </div>
              <div className="w-32">
                <Progress
                  value={Math.min((totalStats.totalTokens / 100000) * 100, 100)}
                  className="h-2"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={expandAllFolders}>
                <ArrowDown className="size-3.5" />
                <span className="hidden sm:inline ml-1">Expand</span>
              </Button>
              <Button variant="outline" size="sm" onClick={collapseAllFolders}>
                <ArrowUp className="size-3.5" />
                <span className="hidden sm:inline ml-1">Collapse</span>
              </Button>
            </div>
          </div>

          <div aria-live="polite" className="sr-only">
            {announcement && lastAnnouncedFolder ? announcement : ''}
          </div>

          <VirtualizedPreviewList state={listState} onFileClick={(key) => onFileClick?.(key)} />

          {batchSelectedFiles.size > 0 && (
            <div className="p-3 border-t bg-muted/30 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{batchSelectedFiles.size} selected</span>
              </div>
              <Button size="sm" variant="destructive" onClick={handleBatchRemove}>
                <FileX2 className="size-3.5 mr-1" />
                Remove Selected
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }
);

VirtualizedPreviewPanelTabbed.displayName = 'VirtualizedPreviewPanelTabbed';
