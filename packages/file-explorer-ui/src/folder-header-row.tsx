import { Badge } from '@brainstrike/ui';
import { getFolderColor } from '@brainstrike/utils';
import { ArrowDown, ArrowUp, Folder } from 'lucide-react';
import { memo } from 'react';

export interface FolderHeaderItem {
  folderId: string;
  fileCount: number;
  totalTokens: number;
}

export interface FolderHeaderRowProps {
  item: FolderHeaderItem;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export const FolderHeaderRow = memo<FolderHeaderRowProps>(function FolderHeaderRow({
  item,
  isCollapsed,
  onToggleCollapse,
}) {
  const colors = getFolderColor(item.folderId);

  return (
    <button
      type="button"
      className="w-full h-full flex items-center gap-3 px-4 py-3 text-left hover:opacity-80 transition-opacity"
      style={{ backgroundColor: colors.light.bg, color: colors.light.text }}
      onClick={onToggleCollapse}
      data-folder-id={item.folderId}
    >
      <style>{`
          :global(.dark) [data-folder-id="${item.folderId}"] {
            background-color: ${colors.dark.bg} !important;
            color: ${colors.dark.text} !important;
          }
        `}</style>
      <div className="flex items-center gap-2">
        {isCollapsed ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
        <Folder className="h-4 w-4" />
      </div>
      <span className="flex-1 truncate font-medium">{item.folderId}</span>
      <div className="flex items-center gap-2 text-xs opacity-80">
        <span>{item.fileCount} files</span>
        {item.totalTokens > 0 && (
          <Badge variant="secondary" className="text-xs">
            {item.totalTokens.toLocaleString()}
          </Badge>
        )}
      </div>
    </button>
  );
});

FolderHeaderRow.displayName = 'FolderHeaderRow';

export default FolderHeaderRow;
