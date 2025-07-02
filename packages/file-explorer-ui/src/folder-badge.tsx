import { Badge, cn } from '@brainstrike/ui';
import { getFolderColor } from '@brainstrike/utils';
import { Folder } from 'lucide-react';
import * as React from 'react';

interface FolderBadgeProps {
  folderId: string;
  className?: string;
}

export const FolderBadge = React.memo(({ folderId, className }: FolderBadgeProps) => {
  const colors = getFolderColor(folderId);

  return (
    <Badge
      variant="secondary"
      className={cn(
        'flex items-center gap-1 px-2 py-0.5 shrink-0 transition-colors dark:!bg-[var(--folder-dark-bg)] dark:!text-[var(--folder-dark-text)]',
        className
      )}
      style={
        {
          '--folder-bg': colors?.light.bg,
          '--folder-text': colors?.light.text,
          '--folder-dark-bg': colors?.dark.bg,
          '--folder-dark-text': colors?.dark.text,
          backgroundColor: 'var(--folder-bg)',
          color: 'var(--folder-text)',
        } as React.CSSProperties
      }
    >
      <Folder className="h-3 w-3" />
      <span className="text-xs font-medium">{folderId}</span>
    </Badge>
  );
});
