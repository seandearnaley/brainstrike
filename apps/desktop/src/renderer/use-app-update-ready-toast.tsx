import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import { callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import { ToastAction, toast } from '@brainstrike/ui';
import { useEffect } from 'react';

function restartToUpdate(bridge: NonNullable<Window['appUpdates']>): void {
  callBoundary(() => bridge.restartToUpdate()).catch((error: unknown) => {
    toast({
      description: describeBoundaryError(error),
      title: "Couldn't restart to update",
      variant: 'destructive',
    });
  });
}

/**
 * BST-2356: once Main finishes downloading an update, the window offers
 * Restart to update. Only a download this window sees finish raises it; a
 * window opened later finds the same offer in Settings › Updates.
 */
export function useAppUpdateReadyToast(): void {
  useEffect(() => {
    const bridge = window.appUpdates;
    if (!bridge) {
      return;
    }
    let offeredVersion: string | null = null;
    return bridge.onStatusChange((status) => {
      if (status.state !== 'ready' || status.version === offeredVersion) {
        return;
      }
      offeredVersion = status.version;
      toast({
        action: (
          <ToastAction
            altText="Restart Brainstrike to install the update"
            data-testid="app-update-restart"
            onClick={() => restartToUpdate(bridge)}
          >
            Restart to update
          </ToastAction>
        ),
        description: 'It installs when you quit, or restart now.',
        // The toast IS the offer; a 5 s default would take it away unseen.
        persistent: true,
        title: `Brainstrike ${status.version} is ready to install`,
      });
    });
  }, []);
}
