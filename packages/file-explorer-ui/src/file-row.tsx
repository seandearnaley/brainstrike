import { Button, Checkbox } from '@brainstrike/ui';
import { FileIcon, FileX2, Loader2 } from 'lucide-react';
import { memo } from 'react';

export interface FileRowItem {
  compositeKey: string;
  folderId: string;
  path: string;
  size?: number;
  tokens?: number;
}

export interface FileRowProps {
  item: FileRowItem;
  isSelected: boolean;
  isLoading: boolean;
  onToggleSelection: (checked: boolean) => void;
  onRemove: () => void;
  onShowDetail: () => void;
  formatFileSize: (bytes?: number) => string;
}

export const FileRow = memo<FileRowProps>(function FileRow({
  item,
  isSelected,
  isLoading,
  onToggleSelection,
  onRemove,
  onShowDetail,
  formatFileSize,
}) {
  return (
    <div className="w-full h-full flex items-center gap-3 px-4 py-2 hover:bg-muted/50 border-b border-border/50">
      <Checkbox
        checked={isSelected}
        onCheckedChange={(checked) => onToggleSelection(checked === true)}
        className="flex-shrink-0"
      />

      <FileIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />

      <button
        type="button"
        className="flex-1 min-w-0 text-left hover:text-primary transition-colors"
        onClick={onShowDetail}
      >
        <div className="truncate font-mono text-sm" title={item.path}>
          {item.path}
        </div>
      </button>

      <div className="flex items-center gap-3 flex-shrink-0 text-xs text-muted-foreground">
        {isLoading && <Loader2 className="h-3 w-3 animate-spin" data-testid="loading-spinner" />}
        <span className="min-w-[60px] text-right">{formatFileSize(item.size)}</span>
        <span className="min-w-[50px] text-right">
          {item.tokens ? item.tokens.toLocaleString() : 'N/A'}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onRemove}
          title="Remove from selection"
        >
          <FileX2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
});

FileRow.displayName = 'FileRow';

export default FileRow;
