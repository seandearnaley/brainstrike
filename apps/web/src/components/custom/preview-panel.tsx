import {
  Badge,
  Button,
  Checkbox,
  Progress,
  ScrollArea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { formatTokenCount } from '@brainstrike/utils';
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  ArrowUpDown,
  FileX2,
  Folder,
  Loader2,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUndoableAction } from '../../hooks/use-undoable-action';
import { getFolderColor } from '../../utils/color-utils';
import { decodeFileSelection } from '../../utils/file-selection-utils';
import {
  countTokensHeuristic,
  estimateTokenCost,
} from '../../utils/token-utils';

interface PreviewPanelProps {
  selectedFiles: Set<string>;
  fileContents: { [compositeKey: string]: string };
  loadingFiles: Set<string>;
  onSelectionChange: (files: Set<string>) => void;
  fileSizes?: { [compositeKey: string]: number }; // Optional map of file sizes
}

interface FolderGroup {
  folderId: string;
  files: {
    compositeKey: string;
    path: string;
    size?: number; // Optional file size in bytes
    tokens?: number; // Optional token count
  }[];
  totalTokens: number; // Total tokens in the folder
}

interface SortConfig {
  key: string;
  direction: 'asc' | 'desc';
}

export const PreviewPanel: React.FC<PreviewPanelProps> = ({
  selectedFiles,
  fileContents,
  loadingFiles,
  onSelectionChange,
  fileSizes,
}: PreviewPanelProps) => {
  const { performUndoableAction } = useUndoableAction<string, Set<string>>();
  const [batchSelectedFiles, setBatchSelectedFiles] = useState<Set<string>>(new Set());
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    key: 'path',
    direction: 'asc',
  });

  // Use ref to track previous selectedFiles to detect changes
  const prevSelectedFilesRef = useRef<Set<string> | null>(null);

  // Reset batch selections when selectedFiles change
  if (prevSelectedFilesRef.current !== selectedFiles) {
    prevSelectedFilesRef.current = selectedFiles;
    // Only reset if this isn't the first render
    if (prevSelectedFilesRef.current !== null) {
      setBatchSelectedFiles(new Set());
    }
  }

  // Group files by folder
  const folderGroups = useMemo(() => {
    const groups: Record<string, FolderGroup> = {};

    for (const compositeKey of selectedFiles) {
      const { folderId, path } = decodeFileSelection(compositeKey);

      if (!groups[folderId]) {
        groups[folderId] = {
          folderId,
          files: [],
          totalTokens: 0,
        };
      }

      // Determine file size:
      // 1. Use provided fileSizes if available
      // 2. Otherwise, use the length of fileContents as an approximation
      // 3. If content isn't loaded yet, use undefined
      let fileSize: number | undefined;
      let tokenCount: number | undefined;

      if (fileContents[compositeKey]) {
        // Calculate token count for text content
        const content = fileContents[compositeKey];

        // Skip token calculation for error messages and binary files
        if (!content.startsWith('File not accessible') && !content.startsWith('Binary file')) {
          // Use faster heuristic for larger files (>100KB)
          // We're using heuristic for all files to avoid Promise handling in a synchronous context
          tokenCount = countTokensHeuristic(content);

          // Add to folder total
          if (typeof tokenCount === 'number') {
            groups[folderId].totalTokens += tokenCount;
          }
        }

        // Calculate file size
        if (fileSizes && fileSizes[compositeKey] !== undefined) {
          fileSize = fileSizes[compositeKey];
        } else {
          fileSize = new TextEncoder().encode(content).length;
        }
      }

      groups[folderId].files.push({
        compositeKey,
        path,
        ...(fileSize !== undefined ? { size: fileSize } : {}),
        ...(tokenCount !== undefined ? { tokens: tokenCount } : {}),
      });
    }

    // Sort files within each folder group
    for (const group of Object.values(groups)) {
      group.files.sort((a, b) => {
        const { key, direction } = sortConfig;
        const multiplier = direction === 'asc' ? 1 : -1;

        switch (key) {
          case 'path':
            return multiplier * a.path.localeCompare(b.path);
          case 'size':
            return multiplier * ((a.size || 0) - (b.size || 0));
          case 'tokens':
            return multiplier * ((a.tokens || 0) - (b.tokens || 0));
          default:
            return 0;
        }
      });
    }

    return Object.values(groups);
  }, [selectedFiles, sortConfig, fileSizes, fileContents]);

  const handleRemoveFile = useCallback(
    (compositeKey: string) => {
      const { path } = decodeFileSelection(compositeKey);
      const newSelectedFiles = new Set(selectedFiles);
      newSelectedFiles.delete(compositeKey);
      onSelectionChange(newSelectedFiles);

      performUndoableAction(compositeKey, compositeKey, {
        actionName: 'File removed',
        itemDescription: `Removed "${path}" from selection`,
        getStateSnapshot: () => new Set(selectedFiles),
        onUndo: (key, snapshot) => {
          const restoredFiles = new Set(snapshot);
          restoredFiles.add(key);
          onSelectionChange(restoredFiles);
        },
      });
    },
    [selectedFiles, onSelectionChange, performUndoableAction]
  );

  const handleBatchRemove = useCallback(() => {
    if (batchSelectedFiles.size === 0) return;

    const newSelectedFiles = new Set(selectedFiles);

    for (const compositeKey of batchSelectedFiles) {
      newSelectedFiles.delete(compositeKey);
    }

    onSelectionChange(newSelectedFiles);

    performUndoableAction('batch-remove', 'batch-remove', {
      actionName: 'Files removed',
      itemDescription: `Removed ${batchSelectedFiles.size} files from selection`,
      getStateSnapshot: () => new Set(selectedFiles),
      onUndo: (_, snapshot) => {
        const restoredFiles = new Set(snapshot);
        onSelectionChange(restoredFiles);
      },
    });

    setBatchSelectedFiles(new Set());
  }, [batchSelectedFiles, selectedFiles, onSelectionChange, performUndoableAction]);

  const toggleFileSelection = useCallback((compositeKey: string, checked: boolean) => {
    setBatchSelectedFiles((prev) => {
      const newSelection = new Set(prev);
      if (checked) {
        newSelection.add(compositeKey);
      } else {
        newSelection.delete(compositeKey);
      }
      return newSelection;
    });
  }, []);

  const toggleFolderSelection = useCallback(
    (files: { compositeKey: string }[], checked: boolean) => {
      setBatchSelectedFiles((prev) => {
        const newSelection = new Set(prev);

        for (const { compositeKey } of files) {
          if (checked) {
            newSelection.add(compositeKey);
          } else {
            newSelection.delete(compositeKey);
          }
        }

        return newSelection;
      });
    },
    []
  );

  const toggleExpand = useCallback((itemId: string) => {
    setExpandedItems((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  }, []);

  const toggleFolderExpand = useCallback((folderId: string) => {
    setExpandedFolders((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(folderId)) {
        newSet.delete(folderId);
      } else {
        newSet.add(folderId);
      }
      return newSet;
    });
  }, []);

  const handleSort = useCallback((key: string) => {
    setSortConfig((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }));
  }, []);

  const formatFileSize = useCallback((bytes?: number) => {
    if (bytes === undefined) return 'Unknown';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }, []);

  const formatTokens = useCallback((tokens?: number) => {
    if (tokens === undefined) return 'N/A';
    return formatTokenCount(tokens);
  }, []);

  const renderSortButton = useCallback(
    (label: string, key: string) => (
      <Button
        variant="ghost"
        onClick={() => handleSort(key)}
        className="h-8 flex items-center gap-1 -ml-3"
      >
        {label}
        <ArrowUpDown className="h-4 w-4" />
      </Button>
    ),
    [handleSort]
  );

  const renderFileContent = useCallback(
    (compositeKey: string) => {
      const content = fileContents[compositeKey];

      return (
        <div
          className="h-[400px] overflow-y-scroll overscroll-contain pointer-events-auto scrollbar-thin scrollbar-thumb-rounded scrollbar-thumb-gray-400 dark:scrollbar-thumb-gray-600"
          onWheel={(e) => e.stopPropagation()}
        >
          <pre className="whitespace-pre-wrap p-4 bg-gray-50 dark:bg-gray-900 rounded-md text-gray-900 dark:text-gray-50">
            {content ? (
              content.startsWith('File not accessible') ? (
                <div className="flex flex-col gap-2">
                  <p className="text-amber-600 dark:text-amber-400">{content}</p>
                  <p className="text-sm text-gray-500">
                    To access this file, please open the folder again using the folder selection
                    dialog.
                  </p>
                </div>
              ) : (
                content
              )
            ) : loadingFiles.has(compositeKey) ? (
              'Loading...'
            ) : (
              'No content available'
            )}
          </pre>
        </div>
      );
    },
    [fileContents, loadingFiles]
  );

  const renderFolderGroup = useCallback(
    (group: FolderGroup) => {
      const colors = getFolderColor(group.folderId);
      const allFilesInFolderSelected = group.files.every(({ compositeKey }) =>
        batchSelectedFiles.has(compositeKey)
      );
      const someFilesInFolderSelected = group.files.some(({ compositeKey }) =>
        batchSelectedFiles.has(compositeKey)
      );

      const folderCheckboxState = allFilesInFolderSelected
        ? true
        : someFilesInFolderSelected
          ? 'indeterminate'
          : false;

      const isFolderExpanded = expandedFolders.has(group.folderId);

      return (
        <div key={group.folderId} className="mb-4 rounded-lg overflow-hidden @container/card">
          <button
            type="button"
            className="flex items-center gap-2 p-3 font-medium cursor-pointer w-full text-left"
            style={{
              backgroundColor: `var(--folder-bg, ${colors.light.bg})`,
              color: `var(--folder-text, ${colors.light.text})`,
            }}
            onClick={() => toggleFolderExpand(group.folderId)}
            aria-expanded={isFolderExpanded}
          >
            <style>
              {`
                :global(.dark) [data-folder-id="${group.folderId}"] {
                  background-color: var(--folder-dark-bg, ${colors.dark.bg}) !important;
                  color: var(--folder-dark-text, ${colors.dark.text}) !important;
                }
              `}
            </style>
            {isFolderExpanded ? (
              <ArrowDown className="h-4 w-4" />
            ) : (
              <ArrowDownUp className="h-4 w-4" />
            )}
            <Folder className="h-4 w-4" />
            <span className="truncate">{group.folderId}</span>
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs opacity-80">
                {group.files.length} file{group.files.length !== 1 ? 's' : ''}
              </span>
              {group.totalTokens > 0 && (
                <Badge variant="secondary" className="text-xs flex items-center">
                  {formatTokenCount(group.totalTokens)}
                </Badge>
              )}
            </div>
          </button>
          {isFolderExpanded && (
            <div
              className="bg-card from-primary/5 to-card border border-border dark:bg-card rounded-b-lg bg-gradient-to-t shadow-xs"
              data-folder-id={group.folderId}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]">
                      <Checkbox
                        checked={folderCheckboxState}
                        onCheckedChange={(checked) =>
                          toggleFolderSelection(group.files, checked === true)
                        }
                        className="mr-2"
                        aria-label={`Select all files in ${group.folderId}`}
                      />
                    </TableHead>
                    <TableHead className="min-w-[100px] max-w-[200px] w-full">
                      {renderSortButton('File Path', 'path')}
                    </TableHead>
                    <TableHead className="w-[90px]">{renderSortButton('Size', 'size')}</TableHead>
                    <TableHead className="w-[90px]">
                      {renderSortButton('Tokens', 'tokens')}
                    </TableHead>
                    <TableHead className="w-[80px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.files.map((file) => {
                    const isExpanded = expandedItems.has(file.compositeKey);
                    const isLoading = loadingFiles.has(file.compositeKey);
                    const isSelected = batchSelectedFiles.has(file.compositeKey);

                    return (
                      <React.Fragment key={file.compositeKey}>
                        <TableRow>
                          <TableCell className="w-[40px]">
                            <div className="flex items-center">
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={(checked) =>
                                  toggleFileSelection(file.compositeKey, checked === true)
                                }
                                className="mr-2"
                                aria-label={`Select ${file.path}`}
                                onClick={(e) => e.stopPropagation()}
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 p-0"
                                onClick={() => toggleExpand(file.compositeKey)}
                              >
                                <ArrowDown
                                  className={`h-4 w-4 transition-transform duration-200 ${
                                    isExpanded ? 'rotate-180' : ''
                                  }`}
                                />
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell
                            className="font-mono min-w-[100px] max-w-[250px] w-full cursor-pointer"
                            onClick={() => toggleExpand(file.compositeKey)}
                          >
                            <div className="flex items-center">
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div className="truncate text-left w-full">{file.path}</div>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-[300px]">
                                    <p className="font-mono text-xs break-all">{file.path}</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                              {isLoading && (
                                <Loader2
                                  data-testid="loading-spinner"
                                  className="ml-2 h-4 w-4 animate-spin text-blue-500"
                                />
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="w-[90px]">{formatFileSize(file.size)}</TableCell>
                          <TableCell className="w-[90px]">
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="truncate text-left w-full">
                                    {formatTokens(file.tokens)}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>
                                    {file.tokens !== undefined
                                      ? `~${file.tokens.toLocaleString()} tokens`
                                      : 'Token count unavailable'}
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </TableCell>
                          <TableCell className="w-[80px]">
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-7"
                                    onClick={() => handleRemoveFile(file.compositeKey)}
                                    aria-label={`Remove ${file.path} from selection`}
                                  >
                                    <FileX2 className="size-3.5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Remove from selection</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow>
                            <TableCell colSpan={5} className="p-0 border-b-0">
                              {renderFileContent(file.compositeKey)}
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      );
    },
    [
      renderFileContent,
      renderSortButton,
      batchSelectedFiles,
      toggleFolderSelection,
      toggleFileSelection,
      handleRemoveFile,
      loadingFiles,
      expandedItems,
      expandedFolders,
      toggleExpand,
      toggleFolderExpand,
      formatFileSize,
      formatTokens,
    ]
  );

  // Initialize all folders as expanded by default
  useEffect(() => {
    const newExpandedFolders = new Set<string>();
    for (const group of folderGroups) {
      newExpandedFolders.add(group.folderId);
    }
    setExpandedFolders(newExpandedFolders);
  }, [folderGroups]);

  const expandAllFolders = useCallback(() => {
    const newExpandedFolders = new Set<string>();
    for (const group of folderGroups) {
      newExpandedFolders.add(group.folderId);
    }
    setExpandedFolders(newExpandedFolders);
  }, [folderGroups]);

  const collapseAllFolders = useCallback(() => {
    setExpandedFolders(new Set());
  }, []);

  // Calculate total token count across all folders
  const totalTokens = useMemo(() => {
    return folderGroups.reduce((total, group) => total + group.totalTokens, 0);
  }, [folderGroups]);

  // Calculate estimated cost based on GPT-4 pricing
  const estimatedCost = useMemo(() => {
    // Current GPT-4 rates: ~$10/1M input tokens
    return (totalTokens / 1000000) * 10;
  }, [totalTokens]);

  if (selectedFiles.size === 0) {
    return (
      <div className="p-4">
        <p className="text-sm text-gray-500">No files selected</p>
      </div>
    );
  }

  return (
    <div className="@container/preview relative h-full flex flex-col w-full">
      <div className="p-2 border-b flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger tabIndex={-1}>
                <Badge variant="outline" className="py-1.5">
                  {formatTokenCount(totalTokens)}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Token Usage Estimate</p>
                  <p className="text-xs text-muted-foreground">
                    Total: {totalTokens.toLocaleString()} tokens
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Est. cost: ${estimatedCost.toFixed(4)} (GPT-4 rates)
                  </p>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <div className="text-xs text-muted-foreground hidden @md/preview:block">
            <span className="font-medium">{selectedFiles.size}</span> files selected |
            <span className="font-medium"> {totalTokens.toLocaleString()}</span> tokens | Est. cost:{' '}
            <span className="font-medium">${estimatedCost.toFixed(4)}</span>
          </div>

          <div className="w-36 mx-4 hidden @md/preview:block">
            <Progress
              value={Math.min((totalTokens / 100000) * 100, 100)}
              className="h-2"
              aria-label="Token usage"
            />
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={expandAllFolders}
            className="flex items-center gap-1"
          >
            <ArrowDown className="size-3.5" />
            <span className="hidden @sm/preview:inline">Expand All</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={collapseAllFolders}
            className="flex items-center gap-1"
          >
            <ArrowUp className="size-3.5" />
            <span className="hidden @sm/preview:inline">Collapse All</span>
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-4">{folderGroups.map(renderFolderGroup)}</div>
      </ScrollArea>

      {batchSelectedFiles.size > 0 &&
        (() => {
          // Calculate tokens for selected files
          let selectedTokens = 0;
          let tokensPercent = 0;

          for (const compositeKey of batchSelectedFiles) {
            // Find the file in folder groups
            for (const group of folderGroups) {
              const file = group.files.find((f) => f.compositeKey === compositeKey);
              selectedTokens += file?.tokens ?? 0;
            }
          }

          // Calculate percentage of total tokens
          if (totalTokens > 0) {
            tokensPercent = Math.round((selectedTokens / totalTokens) * 100);
          }

          return (
            <div className="absolute bottom-0 left-0 right-0 bg-muted/30 dark:bg-muted/30 border-t border-border p-2 flex items-center justify-between transition-all duration-200 ease-in-out animate-in slide-in-from-bottom-2">
              <div className="flex items-center gap-2 ml-2">
                <span className="text-sm font-medium">
                  {batchSelectedFiles.size} item
                  {batchSelectedFiles.size !== 1 ? 's' : ''} selected
                </span>

                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="secondary" className="text-xs">
                        {formatTokenCount(selectedTokens)}
                        {tokensPercent > 0 && ` (${tokensPercent}%)`}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          Selected: {selectedTokens.toLocaleString()} tokens
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Will save: {selectedTokens.toLocaleString()} tokens
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Est. cost saving: ${estimateTokenCost(selectedTokens).toFixed(4)}
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="flex gap-2 items-center">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="outline"
                        className="bg-green-50 dark:bg-green-900 text-green-800 dark:text-green-200"
                      >
                        New total: {formatTokenCount(totalTokens - selectedTokens)}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          Current total: {totalTokens.toLocaleString()} tokens
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Removing: {selectedTokens.toLocaleString()} tokens (
                          {((selectedTokens / totalTokens) * 100).toFixed(1)}%)
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Est. new cost: $
                          {estimateTokenCost(totalTokens - selectedTokens).toFixed(4)}
                        </p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={handleBatchRemove}
                  className="flex items-center gap-1"
                >
                  <FileX2 className="size-3.5" />
                  <span>Remove Selections</span>
                </Button>
              </div>
            </div>
          );
        })()}
    </div>
  );
};
