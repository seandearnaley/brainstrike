/**
 * The Files app's bulk "Export" action (ADR-0021, BST-2018): copy or download
 * the selected files' contents as one Markdown document, through the
 * explorer's existing context generation, with its project-tree option.
 */
import { type ContextGenerationOverrides, useAdapters } from '@brainstrike/file-explorer-hooks';
import { createLogger } from '@brainstrike/logging';
import {
  Button,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SELECTION_ACTION_BAR_COMPACT_LABEL_CLASS,
  Switch,
} from '@brainstrike/ui';
import { Clipboard, Download, FileOutput } from 'lucide-react';
import { type ReactElement, useCallback, useId, useState } from 'react';
import { persistFileExplorerStateImmediately } from '../utils/persist-file-explorer-state';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './file-explorer-provider';
import { useContextExportActions } from './use-context-export-actions';
import { useFileExplorer } from './use-file-explorer-context';
import { useSelectedTokenTotal } from './use-selected-token-total';
import { useSelectionManager } from './use-selection-manager-context';

const logger = createLogger('ExplorerContextExportAction');

export function ExplorerContextExportAction(): ReactElement {
  const { fileContents, loadMultipleFileContents, rootDirectoryHandle } = useFileExplorer();
  const store = useFileExplorerStoreContext();
  const { storageAdapter } = useAdapters();
  // The whole forest: in query mode `selectedFilePaths` is the focused root alone.
  const { forestSelection, selectedCount } = useSelectionManager();
  const tokenTotal = useSelectedTokenTotal(forestSelection);
  const [
    includeProjectTree,
    setIncludeProjectTree,
    includeFilters,
    excludeFilters,
    useRegex,
    folderSummaryThreshold,
    setFolderSummaryThreshold,
  ] = useFileExplorerStoreSelector(
    (state) =>
      [
        state.includeProjectTree,
        state.setIncludeProjectTree,
        state.includeFilters,
        state.excludeFilters,
        state.useRegex,
        state.folderSummaryThreshold,
        state.setFolderSummaryThreshold,
      ] as const
  );
  const [open, setOpen] = useState(false);
  const [treeUsesViewFilters, setTreeUsesViewFilters] = useState(false);
  const [busy, setBusy] = useState(false);
  const includeTreeId = useId();
  const viewFiltersId = useId();
  const treeDetailId = useId();

  const loadBackgroundFileContents = useCallback(
    (compositeKeys: string[]) => loadMultipleFileContents(compositeKeys, 'background'),
    [loadMultipleFileContents]
  );
  const { handleCopyContext, handleDownloadContext } = useContextExportActions({
    excludeFilters,
    fileContents,
    folderSummaryThreshold,
    includeFilters,
    includeProjectTree,
    // Generation owns its nested content reads, so a failed read is reported
    // as the export's failure rather than as a separate load error.
    loadMultipleFileContents: loadBackgroundFileContents,
    projectTreeUsesViewFilters: treeUsesViewFilters,
    rootDirectoryHandle,
    selectedFiles: forestSelection,
    store,
    useRegex,
  });

  const handleIncludeProjectTreeChange = useCallback(
    (checked: boolean) => {
      setIncludeProjectTree(checked);
      persistFileExplorerStateImmediately(store, storageAdapter).catch((error: unknown) => {
        logger.error('Failed to persist includeProjectTree immediately', { error });
      });
    },
    [setIncludeProjectTree, store, storageAdapter]
  );

  const run = async (
    exportContext: (options: ContextGenerationOverrides) => Promise<{ readonly ok: boolean }>
  ) => {
    setBusy(true);
    try {
      const outcome = await exportContext({ projectTreeUsesViewFilters: treeUsesViewFilters });
      if (outcome.ok) {
        setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const files = `${selectedCount.toLocaleString()} ${selectedCount === 1 ? 'file' : 'files'}`;
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Export ${files}`}
          className="gap-1.5 whitespace-nowrap"
          data-testid="explorer-export-trigger"
          disabled={selectedCount === 0}
          size="sm"
          type="button"
          variant="secondary"
        >
          <FileOutput aria-hidden="true" className="h-4 w-4" />
          <span className={SELECTION_ACTION_BAR_COMPACT_LABEL_CLASS}>Export</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-72 flex-col gap-3" side="top">
        <div className="flex flex-col gap-0.5">
          <p className="font-medium text-sm">Export the contents of {files}</p>
          {tokenTotal ? (
            <p className="text-muted-foreground text-xs" data-testid="explorer-export-tokens">
              {tokenTotal.pending > 0
                ? `~${tokenTotal.tokens.toLocaleString()} tokens so far, counting ${tokenTotal.pending.toLocaleString()} more ${tokenTotal.pending === 1 ? 'file' : 'files'}…`
                : `~${tokenTotal.tokens.toLocaleString()} ${tokenTotal.tokens === 1 ? 'token' : 'tokens'}`}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label className="text-sm" htmlFor={includeTreeId}>
            Include project tree
          </Label>
          <Switch
            checked={includeProjectTree}
            data-testid="explorer-export-include-tree"
            id={includeTreeId}
            onCheckedChange={handleIncludeProjectTreeChange}
          />
        </div>
        {includeProjectTree ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <Label className="text-muted-foreground text-sm" htmlFor={viewFiltersId}>
                Tree follows the explorer's filters
              </Label>
              <Switch
                checked={treeUsesViewFilters}
                id={viewFiltersId}
                onCheckedChange={setTreeUsesViewFilters}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label
                className="text-muted-foreground text-sm"
                htmlFor={treeDetailId}
                title="Number of files shown per folder in the project tree before summarizing. Set to 0 to show all."
              >
                Tree detail:
              </Label>
              <input
                className="h-7 w-14 rounded-md border border-input bg-background px-1.5 text-center text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                id={treeDetailId}
                min="0"
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10);
                  if (!Number.isNaN(value) && value >= 0) {
                    setFolderSummaryThreshold(value);
                  }
                }}
                title="Files per folder before summarizing (0 = show all)"
                type="number"
                value={folderSummaryThreshold}
              />
            </div>
          </>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            data-testid="explorer-export-copy"
            disabled={busy}
            onClick={() => {
              void run(handleCopyContext);
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            <Clipboard aria-hidden="true" className="h-4 w-4" />
            Copy
          </Button>
          <Button
            data-testid="explorer-export-download"
            disabled={busy}
            onClick={() => {
              void run(handleDownloadContext);
            }}
            size="sm"
            type="button"
          >
            <Download aria-hidden="true" className="h-4 w-4" />
            Download
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
