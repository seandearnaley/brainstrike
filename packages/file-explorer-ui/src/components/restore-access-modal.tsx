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
  isOpen: boolean;
  folderName: string;
  variant: RestoreAccessModalVariant;
  isRestoring?: boolean;
  onRestore: () => void;
  onDismiss: () => void;
}

const variantCopy: Record<RestoreAccessModalVariant, { title: string; description: string }> = {
  pending: {
    title: 'Restore access to your last folder?',
    description:
      'Your browser remembered the folder you were working with. Click below to restore access and continue where you left off.',
  },
  denied: {
    title: 'Folder access was denied',
    description:
      'Permission to access the folder was denied. You can try again or select a different folder using the toolbar.',
  },
  stale: {
    title: 'Stored folder is no longer accessible',
    description:
      'The folder may have been moved or deleted. Please select a new folder using the toolbar to continue.',
  },
};

export const RestoreAccessModal: React.FC<RestoreAccessModalProps> = ({
  isOpen,
  folderName,
  variant,
  isRestoring = false,
  onRestore,
  onDismiss,
}) => {
  const copy = variantCopy[variant];
  const Icon = variant === 'pending' ? FolderClock : AlertTriangle;
  const showRestoreButton = variant !== 'stale';

  return (
    <Dialog onOpenChange={(open) => !open && onDismiss()} open={isOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Icon className="h-6 w-6 text-primary" />
          </div>
          <DialogTitle className="text-center">{copy.title}</DialogTitle>
          <DialogDescription className="text-center">
            {folderName && <span className="font-medium">"{folderName}"</span>}
            {folderName && ' - '}
            {copy.description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          {showRestoreButton && (
            <Button className="w-full" disabled={isRestoring} onClick={onRestore} size="lg">
              {isRestoring ? 'Restoring...' : 'Restore Access'}
            </Button>
          )}
          <Button className="w-full" onClick={onDismiss} size="lg" variant="ghost">
            {variant === 'stale' ? 'Close' : 'Maybe Later'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

RestoreAccessModal.displayName = 'RestoreAccessModal';
