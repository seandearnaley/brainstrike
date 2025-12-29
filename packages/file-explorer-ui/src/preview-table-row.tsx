import { Badge, Checkbox } from '@brainstrike/ui';
import { FolderOpen } from 'lucide-react';
import { memo } from 'react';
import type { ColumnVisibility } from './hooks/use-preview-panel-persistence';
import { formatTokenCount } from './use-preview-panel-state';
import type { TableRowData } from './utils/grouping-configs';
import { formatDirPathForDisplay, splitFilePath } from './utils/path-display';
import { formatPreviewFileSize } from './utils/preview-formatters';

type PreviewTableRowProps = {
  item: TableRowData;
  isSelected: boolean;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  onFileClick?: ((compositeKey: string) => void) | undefined;
  columnVisibility: ColumnVisibility;
};

export const PreviewTableRow = memo<PreviewTableRowProps>(function PreviewTableRowComponent({
  item,
  isSelected,
  onToggleSelection,
  onFileClick,
  columnVisibility,
}) {
  const { fileName, dirPath } = splitFilePath(item.path);
  const displayDirPath = formatDirPathForDisplay({ dirPath, rootFolderId: item.rootFolderId });

  return (
    <tr className="border-b transition-colors hover:bg-muted/50">
      {columnVisibility.checkbox && (
        <td className="w-12 px-4 py-2">
          <Checkbox
            aria-label={`Select ${item.path}`}
            checked={isSelected}
            onCheckedChange={(checked) => onToggleSelection(item.compositeKey, !!checked)}
            onClick={(e) => e.stopPropagation()}
          />
        </td>
      )}
      {columnVisibility.rootFolderId && (
        <td className="px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <FolderOpen className="size-4 flex-shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate font-mono text-sm" title={item.rootFolderId}>
              {item.rootFolderId}
            </span>
          </div>
        </td>
      )}
      {columnVisibility.path && (
        <td className="px-4 py-2">
          <button
            aria-label={fileName}
            className="block w-full min-w-0 overflow-hidden text-left transition-colors hover:text-primary"
            onClick={(e) => {
              e.preventDefault();
              onFileClick?.(item.compositeKey);
            }}
            title={item.path}
            type="button"
          >
            <div className="truncate font-medium text-sm" title={fileName}>
              {fileName}
            </div>
            {displayDirPath && (
              <div className="truncate font-mono text-muted-foreground text-xs" title={dirPath}>
                {displayDirPath}
              </div>
            )}
          </button>
        </td>
      )}
      {columnVisibility.type && (
        <td className="w-20 px-4 py-2">
          <Badge className="text-xs" variant="secondary">
            {item.type}
          </Badge>
        </td>
      )}
      {columnVisibility.tokens && (
        <td className="w-24 whitespace-nowrap px-4 py-2 text-right tabular-nums">
          {item.tokens ? (
            <span className="whitespace-nowrap font-mono text-sm tabular-nums">
              {formatTokenCount(item.tokens)}
            </span>
          ) : (
            <span className="text-muted-foreground text-sm">—</span>
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
