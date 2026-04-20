import { Checkbox } from '@brainstrike/ui';
import { FolderOpen } from 'lucide-react';
import { memo, useCallback } from 'react';
import { ExtensionBadge } from './extension-badge';
import type { ColumnVisibility } from './hooks/use-preview-panel-persistence';
import { formatTokenCount } from './use-preview-panel-state';
import type { TableRowData } from './utils/grouping-configs';
import {
  formatFilePathSubtitle,
  getRootFolderDisplayName,
  splitFilePath,
} from './utils/path-display';
import { formatPreviewFileSize } from './utils/preview-formatters';

interface PreviewTableRowProps {
  columnVisibility: ColumnVisibility;
  isSelected: boolean;
  item: TableRowData;
  onFileClick?: ((compositeKey: string) => void) | undefined;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
}

export const PreviewTableRow = memo<PreviewTableRowProps>(function PreviewTableRowComponent({
  item,
  isSelected,
  onToggleSelection,
  onFileClick,
  columnVisibility,
}) {
  const { fileName } = splitFilePath(item.path);
  const displayDirPath = formatFilePathSubtitle({
    filePath: item.path,
    rootFolderId: item.rootFolderId,
  });
  const displayRootFolder = getRootFolderDisplayName(item.rootFolderId);

  const handleCheckedChange = useCallback(
    (checked: boolean | 'indeterminate') => onToggleSelection(item.compositeKey, !!checked),
    [item.compositeKey, onToggleSelection]
  );

  const handleCheckboxClick = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  const handleFileClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onFileClick?.(item.compositeKey);
    },
    [item.compositeKey, onFileClick]
  );

  return (
    <tr className="border-b transition-colors hover:bg-muted/50">
      {columnVisibility.checkbox && (
        <td className="w-8 px-0 py-2">
          <div className="flex h-full items-center justify-center">
            <Checkbox
              aria-label={`Select ${item.path}`}
              checked={isSelected}
              onCheckedChange={handleCheckedChange}
              onClick={handleCheckboxClick}
            />
          </div>
        </td>
      )}
      {columnVisibility.rootFolderId && (
        <td className="px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <FolderOpen className="size-4 flex-shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate font-mono text-sm" title={item.rootFolderId}>
              {displayRootFolder}
            </span>
          </div>
        </td>
      )}
      {columnVisibility.path && (
        <td className="px-4 py-2">
          <button
            aria-label={fileName}
            className="block w-full min-w-0 overflow-hidden text-left transition-colors hover:text-primary"
            onClick={handleFileClick}
            title={item.path}
            type="button"
          >
            <div className="truncate font-medium text-sm" title={fileName}>
              {fileName}
            </div>
            {displayDirPath && (
              <div className="truncate font-mono text-muted-foreground text-xs" title={item.path}>
                {displayDirPath}
              </div>
            )}
          </button>
        </td>
      )}
      {columnVisibility.type && (
        <td className="w-24 px-4 py-2">
          <ExtensionBadge extension={item.type} />
        </td>
      )}
      {columnVisibility.tokens && (
        <td className="w-24 whitespace-nowrap px-4 py-2 text-right tabular-nums">
          {item.tokens === undefined ? (
            <span className="text-muted-foreground text-sm">—</span>
          ) : (
            <span className="whitespace-nowrap font-mono text-sm tabular-nums">
              {formatTokenCount(item.tokens)}
            </span>
          )}
        </td>
      )}
      {columnVisibility.size && (
        <td className="w-24 whitespace-nowrap px-4 py-2 text-right tabular-nums">
          <span
            className={
              item.size === undefined
                ? 'text-muted-foreground text-sm'
                : 'whitespace-nowrap font-mono text-sm tabular-nums'
            }
          >
            {formatPreviewFileSize(item.size)}
          </span>
        </td>
      )}
    </tr>
  );
});

PreviewTableRow.displayName = 'PreviewTableRow';
