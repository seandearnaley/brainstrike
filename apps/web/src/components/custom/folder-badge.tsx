import { Badge } from '@brainstrike/ui';
import { Folder } from 'lucide-react';
import { cn } from '../../lib/utils';
import { getFolderColor } from '@brainstrike/utils';

interface FolderBadgeProps {
  folderId: string;
  className?: string;
}

export function FolderBadge({ folderId, className }: FolderBadgeProps) {
  const colors = getFolderColor(folderId);

  return (
    <Badge
      variant="secondary"
      className={cn('flex items-center gap-1 px-2 py-0.5 shrink-0 transition-colors', className)}
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
      <style>
        {`
          :global(.dark) .badge {
            background-color: var(--folder-dark-bg) !important;
            color: var(--folder-dark-text) !important;
          }
        `}
      </style>
      <Folder className="h-3 w-3" />
      <span className="text-xs font-medium">{folderId}</span>
    </Badge>
  );
}
