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
  formatFileSize: (bytes?: number) => string;
  isLoading: boolean;
  isSelected: boolean;
  item: FileRowItem;
  onRemove: () => void;
  onShowDetail: () => void;
  onToggleSelection: (checked: boolean) => void;
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
    <div className="flex h-full w-full items-center gap-3 border-border/50 border-b px-4 py-2 hover:bg-muted/50">
      <Checkbox
        checked={isSelected}
        className="flex-shrink-0"
        onCheckedChange={(checked) => onToggleSelection(checked === true)}
      />

      <FileIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />

      <button
        className="min-w-0 flex-1 cursor-pointer text-left transition-colors hover:text-primary"
        onClick={onShowDetail}
        type="button"
      >
        <div className="truncate font-mono text-sm" title={item.path}>
          {item.path}
        </div>
      </button>

      <div className="flex flex-shrink-0 items-center gap-3 text-muted-foreground text-xs">
        {isLoading && <Loader2 className="h-3 w-3 animate-spin" data-testid="loading-spinner" />}
        <span className="min-w-[60px] text-right">{formatFileSize(item.size)}</span>
        <span className="min-w-[50px] text-right">
          {item.tokens === undefined ? 'N/A' : item.tokens.toLocaleString()}
        </span>
        <Button
          aria-label="Remove from selection"
          className="h-7 w-7"
          onClick={onRemove}
          size="icon"
          title="Remove from selection"
          variant="ghost"
        >
          <FileX2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
});

FileRow.displayName = 'FileRow';

export default FileRow;
