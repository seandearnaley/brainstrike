import { Badge, Checkbox } from '@brainstrike/ui';
import { FolderOpen } from 'lucide-react';
import { memo, useCallback } from 'react';
import { useFileContentPriority } from './file-content-context';
import type { ColumnVisibility } from './hooks/use-preview-panel-persistence';
import { formatTokenCount } from './use-preview-panel-state';
import type { TableRowData } from './utils/grouping-configs';

interface PreviewTableRowProps {
  item: TableRowData;
  isSelected: boolean;
  onToggleSelection: (compositeKey: string, checked: boolean) => void;
  onFileClick?: (compositeKey: string) => void;
  columnVisibility: ColumnVisibility;
}

export const PreviewTableRow = memo<PreviewTableRowProps>(function PreviewTableRowComponent({
  item,
  isSelected,
  onToggleSelection,
  onFileClick,
  columnVisibility,
}) {
  const priorityQueueRef = useFileContentPriority();
  const fileName = item.path.split('/').pop() || item.path;
  const dirPath = item.path.substring(0, item.path.lastIndexOf('/'));

  const handleMouseEnter = useCallback(() => {
    // Move this key to the front of the priority queue
    const existing = priorityQueueRef.current.filter((k) => k !== item.compositeKey);
    priorityQueueRef.current = [item.compositeKey, ...existing];
  }, [item.compositeKey, priorityQueueRef]);

  return (
    <tr className="border-b transition-colors hover:bg-muted/50" onMouseEnter={handleMouseEnter}>
      {columnVisibility.checkbox && (
        <td className="p-4 w-12">
          <Checkbox
            checked={isSelected}
            onCheckedChange={(checked) => onToggleSelection(item.compositeKey, !!checked)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${item.path}`}
          />
        </td>
      )}
      {columnVisibility.rootFolderId && (
        <td className="p-4">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-4 text-muted-foreground flex-shrink-0" />
            <span className="font-mono text-sm truncate">{item.rootFolderId}</span>
          </div>
        </td>
      )}
      {columnVisibility.path && (
        <td className="p-4 min-w-0 flex-1">
          <button
            type="button"
            className="min-w-0 text-left w-full hover:text-primary transition-colors"
            onClick={(e) => {
              e.preventDefault();
              onFileClick?.(item.compositeKey);
            }}
            aria-label={fileName}
          >
            <div className="font-medium text-sm truncate">{fileName}</div>
            {dirPath && (
              <div className="text-xs text-muted-foreground truncate font-mono">{dirPath}</div>
            )}
          </button>
        </td>
      )}
      {columnVisibility.type && (
        <td className="p-4 w-20">
          <Badge variant="secondary" className="text-xs">
            {item.type}
          </Badge>
        </td>
      )}
      {columnVisibility.tokens && (
        <td className="p-4 w-24 text-right">
          {item.tokens ? (
            <span className="font-mono text-sm">{formatTokenCount(item.tokens)}</span>
          ) : (
            <span className="text-muted-foreground text-sm">—</span>
          )}
        </td>
      )}
      {columnVisibility.size && (
        <td className="p-4 w-24 text-right">
          {item.size ? (
            <span className="font-mono text-sm">{(item.size / 1024).toFixed(1)} KB</span>
          ) : (
            <span className="text-muted-foreground text-sm">—</span>
          )}
        </td>
      )}
    </tr>
  );
});

PreviewTableRow.displayName = 'PreviewTableRow';
