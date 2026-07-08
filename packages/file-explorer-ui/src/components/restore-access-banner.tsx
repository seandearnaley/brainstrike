import { Button, Card, CardContent } from '@brainstrike/ui';
import { AlertTriangle, FolderClock, FolderOpen } from 'lucide-react';
import type * as React from 'react';

export type RestoreAccessBannerVariant = 'pending' | 'denied' | 'stale';

export interface RestoreAccessBannerProps {
  /** One or more folder names needing restore. When multiple, the title says "N folders". */
  folderNames: readonly string[];
  onChooseDifferent: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  variant: RestoreAccessBannerVariant;
}

const SINGLE_FOLDER_PENDING_TITLE = 'Restore access to your last folder?';

function pendingTitle(count: number): string {
  return count > 1 ? `Restore access to ${count} folders` : SINGLE_FOLDER_PENDING_TITLE;
}

const variantDescription: Record<RestoreAccessBannerVariant, string> = {
  denied: 'You can try again later or choose a different folder to continue.',
  pending:
    'Your browser can remember the folder, but access needs confirmation before we can reopen it.',
  stale: 'The folder may have been moved or deleted. Choose another folder to continue working.',
};

const variantTitle: Record<Exclude<RestoreAccessBannerVariant, 'pending'>, string> = {
  denied: 'Folder access was denied',
  stale: 'Stored folder is no longer accessible',
};

export const RestoreAccessBanner: React.FC<RestoreAccessBannerProps> = ({
  folderNames,
  variant,
  onRestore,
  onChooseDifferent,
  onDismiss,
}) => {
  const description = variantDescription[variant];
  const title = variant === 'pending' ? pendingTitle(folderNames.length) : variantTitle[variant];
  const Icon = variant === 'pending' ? FolderClock : AlertTriangle;

  // For single folder: show its name. For multiple: show count in description.
  const folderLabel =
    folderNames.length === 1
      ? `"${folderNames[0]}" - `
      : folderNames.length > 1
        ? `${folderNames.length} folders - `
        : '';

  return (
    <Card className="mx-2 mt-2 border-dashed bg-muted/20 shadow-none">
      <CardContent className="flex flex-col gap-3 p-3">
        <div className="flex items-start gap-3">
          <div className="mt-1 rounded-full bg-primary/10 p-2 text-primary">
            <Icon className="h-4 w-4" />
          </div>
          <div className="flex flex-col">
            <p className="font-medium text-sm">{title}</p>
            <p className="text-muted-foreground text-xs">
              {folderLabel}
              {description}
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
