import { Badge } from '@brainstrike/ui';
import { getFolderColor } from '@brainstrike/utils/color-utils';
import { ArrowDown, ArrowUp, Folder } from 'lucide-react';
import { type CSSProperties, memo, useMemo } from 'react';

export interface FolderHeaderItem {
  fileCount: number;
  folderId: string;
  totalTokens: number;
}

export interface FolderHeaderRowProps {
  isCollapsed: boolean;
  item: FolderHeaderItem;
  onToggleCollapse: () => void;
}

type FolderHeaderRowStyle = CSSProperties &
  Record<'--folder-dark-bg' | '--folder-dark-text', string>;

const FolderHeaderRowComponent = ({
  item,
  isCollapsed,
  onToggleCollapse,
}: FolderHeaderRowProps) => {
  const rowStyle = useMemo<FolderHeaderRowStyle>(() => {
    const colors = getFolderColor(item.folderId);
    return {
      '--folder-dark-bg': colors.dark.bg,
      '--folder-dark-text': colors.dark.text,
      backgroundColor: colors.light.bg,
      color: colors.light.text,
    };
  }, [item.folderId]);

  return (
    <button
      aria-expanded={!isCollapsed}
      aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} folder ${item.folderId}`}
      className="flex h-full w-full items-center gap-3 px-4 py-3 text-left transition-opacity hover:opacity-80 dark:[background-color:var(--folder-dark-bg)] dark:[color:var(--folder-dark-text)]"
      data-folder-id={item.folderId}
      onClick={onToggleCollapse}
      style={rowStyle}
      type="button"
    >
      <div className="flex items-center gap-2">
        {isCollapsed ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
        <Folder className="h-4 w-4" />
      </div>
      <span className="flex-1 truncate font-medium">{item.folderId}</span>
      <div className="flex items-center gap-2 text-xs opacity-80">
        <span>{item.fileCount} files</span>
        {item.totalTokens > 0 && (
          <Badge className="text-xs" variant="secondary">
            {item.totalTokens.toLocaleString()}
          </Badge>
        )}
      </div>
    </button>
  );
};

export const FolderHeaderRow = memo(FolderHeaderRowComponent);

FolderHeaderRow.displayName = 'FolderHeaderRow';

export default FolderHeaderRow;
