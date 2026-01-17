import { Button, Card, CardContent } from '@brainstrike/ui';
import { AlertTriangle, FolderClock, FolderOpen } from 'lucide-react';
import type * as React from 'react';

export type RestoreAccessBannerVariant = 'pending' | 'denied' | 'stale';

export interface RestoreAccessBannerProps {
  folderName: string;
  variant: RestoreAccessBannerVariant;
  onRestore: () => void;
  onChooseDifferent: () => void;
  onDismiss: () => void;
}

const variantCopy: Record<RestoreAccessBannerVariant, { title: string; description: string }> = {
  pending: {
    title: 'Restore access to your last folder?',
    description:
      'Your browser can remember the folder, but access needs confirmation before we can reopen it.',
  },
  denied: {
    title: 'Folder access was denied',
    description: 'You can try again later or choose a different folder to continue.',
  },
  stale: {
    title: 'Stored folder is no longer accessible',
    description:
      'The folder may have been moved or deleted. Choose another folder to continue working.',
  },
};

export const RestoreAccessBanner: React.FC<RestoreAccessBannerProps> = ({
  folderName,
  variant,
  onRestore,
  onChooseDifferent,
  onDismiss,
}) => {
  const copy = variantCopy[variant];
  const Icon = variant === 'pending' ? FolderClock : AlertTriangle;

  return (
    <Card className="mx-2 mt-2 border-dashed bg-muted/20 shadow-none">
      <CardContent className="flex flex-col gap-3 p-3">
        <div className="flex items-start gap-3">
          <div className="mt-1 rounded-full bg-primary/10 p-2 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <div className="flex flex-col">
            <p className="font-medium text-sm">{copy.title}</p>
            <p className="text-muted-foreground text-xs">
              {folderName ? `"${folderName}" - ` : ''}
              {copy.description}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {variant !== 'stale' && (
            <Button onClick={onRestore} size="sm" variant="default">
              Restore Access
            </Button>
          )}
          <Button
            onClick={onChooseDifferent}
            size="sm"
            variant={variant === 'stale' ? 'default' : 'outline'}
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            Choose Different Folder
          </Button>
          <Button onClick={onDismiss} size="sm" variant="ghost">
            Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

RestoreAccessBanner.displayName = 'RestoreAccessBanner';
