import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';
import { AlertTriangle, FolderClock } from 'lucide-react';
import type * as React from 'react';

export type RestoreAccessModalVariant = 'pending' | 'denied' | 'stale';

export interface RestoreAccessModalProps {
  /** One or more folder names. When multiple, the aria-label uses a count. */
  folderNames: readonly string[];
  isOpen: boolean;
  isRestoring?: boolean;
  onChooseDifferentFolder: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  variant: RestoreAccessModalVariant;
}

const variantCopy = {
  pending: {
    title: 'Restore access to your last folder?',
    description:
      'Your browser remembered the folder you were working with. Restore access to continue where you left off, or choose a different folder.',
  },
  denied: {
    title: 'Folder access was denied',
    description:
      'Permission to access the folder was denied. Try again or choose a different folder to continue.',
  },
  stale: {
    title: 'Stored folder is no longer accessible',
    description: 'The folder may have been moved or deleted. Choose a new folder to continue.',
  },
} as const satisfies Record<RestoreAccessModalVariant, { title: string; description: string }>;

export const RestoreAccessModal: React.FC<RestoreAccessModalProps> = ({
  isOpen,
  folderNames,
  variant,
  isRestoring = false,
  onChooseDifferentFolder,
  onRestore,
  onDismiss,
}) => {
  const copy = variantCopy[variant];
  const Icon = variant === 'pending' ? FolderClock : AlertTriangle;
  const showRestoreButton = variant !== 'stale';

  // Derive a single display name for labels (first name, or count for multi)
  const folderLabel =
    folderNames.length === 1
      ? folderNames[0]
      : folderNames.length > 1
        ? `${folderNames.length} folders`
        : 'folder';

  // Generate descriptive label for screen readers
  const ariaLabel =
    variant === 'pending'
      ? `Restore access to folder ${folderLabel}`
      : variant === 'denied'
        ? `Access to folder ${folderLabel} was denied`
        : `Folder ${folderLabel} is no longer accessible`;

  return (
    <Dialog onOpenChange={(open) => !open && onDismiss()} open={isOpen}>
      <DialogContent aria-label={ariaLabel} className="sm:max-w-md" role="alertdialog">
        <DialogHeader>
          <div
            aria-hidden="true"
            className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10"
          >
            <Icon className="h-6 w-6 text-primary" />
          </div>
          <DialogTitle className="text-center">{copy.title}</DialogTitle>
          <DialogDescription className="text-center">
            {folderLabel && <span className="font-medium">"{folderLabel}"</span>}
            {folderLabel && ' - '}
            {copy.description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          {showRestoreButton && (
            <Button
              aria-busy={isRestoring}
              aria-label={isRestoring ? 'Restoring folder access' : 'Restore folder access'}
              className="w-full"
              disabled={isRestoring}
              onClick={onRestore}
              size="lg"
            >
              {isRestoring ? 'Restoring...' : 'Restore Access'}
            </Button>
          )}
          <Button
            aria-label="Choose different folder"
            className="w-full"
            disabled={isRestoring}
            onClick={onChooseDifferentFolder}
            size="lg"
            variant={showRestoreButton ? 'secondary' : 'default'}
          >
            Choose Different Folder
          </Button>
          <Button
            aria-label={variant === 'stale' ? 'Close dialog' : 'Dismiss and restore later'}
            className="w-full"
            onClick={onDismiss}
            size="lg"
            variant="ghost"
          >
            {variant === 'stale' ? 'Close' : 'Maybe Later'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

RestoreAccessModal.displayName = 'RestoreAccessModal';
