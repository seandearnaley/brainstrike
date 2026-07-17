import { Badge, cn } from '@brainstrike/ui';
import { getFolderColor } from '@brainstrike/utils/color-utils';
import { Folder } from 'lucide-react';
import * as React from 'react';

interface FolderBadgeProps {
  className?: string;
  folderId: string;
}

export const FolderBadge = React.memo(({ folderId, className }: FolderBadgeProps) => {
  const colors = getFolderColor(folderId);

  return (
    <Badge
      className={cn(
        'dark:!bg-[var(--folder-dark-bg)] dark:!text-[var(--folder-dark-text)] flex min-w-0 shrink-0 items-center gap-1 px-2 py-0.5 transition-colors',
        className
      )}
      style={
        {
          '--folder-bg': colors?.light.bg,
          '--folder-dark-bg': colors?.dark.bg,
          '--folder-dark-text': colors?.dark.text,
          '--folder-text': colors?.light.text,
          backgroundColor: 'var(--folder-bg)',
          color: 'var(--folder-text)',
        } as React.CSSProperties
      }
      variant="secondary"
    >
      <Folder className="h-3 w-3 shrink-0" />
      <span className="truncate font-medium text-xs">{folderId}</span>
    </Badge>
  );
});
