import { Badge, Checkbox } from '@brainstrike/ui';
import { FolderOpen } from 'lucide-react';
import { memo } from 'react';
import type { ColumnVisibility } from './hooks/use-preview-panel-persistence';
import { formatTokenCount } from './use-preview-panel-state';
import type { TableRowData } from './utils/grouping-configs';

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
  const fileName = item.path.split('/').pop() || item.path;
  const dirPath = item.path.substring(0, item.path.lastIndexOf('/'));

  return (
    <tr className="border-b transition-colors hover:bg-muted/50">
      {columnVisibility.checkbox && (
        <td className="w-12 p-4">
          <Checkbox
            aria-label={`Select ${item.path}`}
            checked={isSelected}
            onCheckedChange={(checked) => onToggleSelection(item.compositeKey, !!checked)}
            onClick={(e) => e.stopPropagation()}
          />
        </td>
      )}
      {columnVisibility.rootFolderId && (
        <td className="p-4">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-4 flex-shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-sm">{item.rootFolderId}</span>
          </div>
        </td>
      )}
      {columnVisibility.path && (
        <td className="min-w-0 flex-1 p-4">
          <button
            aria-label={fileName}
            className="w-full min-w-0 text-left transition-colors hover:text-primary"
            onClick={(e) => {
              e.preventDefault();
              onFileClick?.(item.compositeKey);
            }}
            type="button"
          >
            <div className="truncate font-medium text-sm">{fileName}</div>
            {dirPath && (
              <div className="truncate font-mono text-muted-foreground text-xs">{dirPath}</div>
            )}
          </button>
        </td>
      )}
      {columnVisibility.type && (
        <td className="w-20 p-4">
          <Badge className="text-xs" variant="secondary">
            {item.type}
          </Badge>
        </td>
      )}
      {columnVisibility.tokens && (
        <td className="w-24 p-4 text-right">
          {item.tokens ? (
            <span className="font-mono text-sm">{formatTokenCount(item.tokens)}</span>
          ) : (
            <span className="text-muted-foreground text-sm">—</span>
          )}
        </td>
      )}
      {columnVisibility.size && (
        <td className="w-24 p-4 text-right">
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
