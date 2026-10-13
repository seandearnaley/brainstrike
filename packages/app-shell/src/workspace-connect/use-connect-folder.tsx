import {
  BoundaryFailureError,
  describeBoundaryError,
} from '@brainstrike/assistant-contract/boundary-failure';
/**
 * The ONE seam every W6 entry point converges on (BST-1393, spec §7): the
 * File menu, `brainstrike <path>` argv, macOS `open-file`, `second-instance`
 * argv, File ▸ Open Recent, and a Finder folder drop.
 *
 * SECURITY POSTURE (ruling S1). A path from any of these is a REQUEST, never a
 * grant. `open-file` and argv are attacker-influencable — any other process can
 * run `open -a BrainStrike <path>` — and a mounted root is read access for the
 * agent, so this hook never records a grant. It calls the existing picker-less
 * `addRootDirectoryByPath`, whose TWO main-side gates (the recent-roots ledger,
 * then the managed-worktree authorizer) decide, and renders a refusal that
 * names the folder and offers the REAL picker.
 *
 * That is not the friction it looks like: the ledger holds up to 50 previously
 * granted folders and a disconnect does not revoke a grant, so `brainstrike .`
 * in any repo you have ever opened just works. Only a genuinely new folder
 * costs one picker confirmation.
 *
 * Extracted from `workspace-connect-host.tsx` so the host stays a mount point
 * and this stays testable without a React tree — and so neither file carries
 * the whole gate + toast + narrowing weight at once (Biome
 * `noExcessiveCognitiveComplexity`, pre-authorized remedy).
 */
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import { ToastAction, toast } from '@brainstrike/ui';
import { useCallback } from 'react';
import type { WorkspaceOpenPathRequest } from './workspace-connect-bridge';

const logger = createLogger('ConnectFolder');

export interface ConnectFolderApi {
  /**
   * Present only when the platform can mount a previously granted path
   * without a picker (desktop). Web omits it — no dead entry points.
   *
   * Resolves to the mounted handle on success, `null` on refusal or failure
   * (every failure path already toasts its own reason here) — mirrors
   * `addRootDirectoryByPath`'s own `DirectoryHandle | null` contract so a
   * caller that needs to react to a successful connect (e.g. recording it as
   * a thread secondary, BST-1393 review finding) can, without duplicating
   * this hook's refusal-toast logic.
   */
  readonly connectPath?:
    | ((request: WorkspaceOpenPathRequest) => Promise<DirectoryHandle | null>)
    | undefined;
  /**
   * The ordinary OS picker — the same call the Folder chip's Add folder…
   * makes. Present only when `isFileSystemAccessSupported()` says so
   * (BST-1393 review finding: this used to be unconditional, which un-gated
   * the ⌘K "Open folder…" command on browsers without FSA — Firefox, Safari
   * — where invoking it always threw). Desktop is unaffected: the Electron
   * adapter always reports supported.
   */
  readonly openPicker?: (() => Promise<void>) | undefined;
}

export function useConnectFolder(): ConnectFolderApi {
  const fileSystem = useFileSystem();
  const addRootDirectory = fileSystem.addRootDirectory;
  const addRootDirectoryByPath = fileSystem.addRootDirectoryByPath;
  const isFileSystemAccessSupported = fileSystem.isFileSystemAccessSupported;

  const openPicker = useCallback(async (): Promise<void> => {
    try {
      await addRootDirectory();
    } catch (error: unknown) {
      logger.error('Open Folder failed', { error });
      toast({
        description: describeBoundaryError(error),
        title: 'Could not open that folder',
        variant: 'destructive',
      });
    }
  }, [addRootDirectory]);

  const connectPath = useCallback(
    async ({ origin, path }: WorkspaceOpenPathRequest): Promise<DirectoryHandle | null> => {
      if (!addRootDirectoryByPath) {
        // Structurally unreachable: the caller only exists behind the desktop
        // bridge. Loud rather than a silent no-op.
        logger.error('Folder connection requested without the picker-less capability', {
          origin,
          path,
        });
        return null;
      }
      try {
        const handle = await addRootDirectoryByPath(path);
        if (!handle) {
          toast({
            description: `${path} could not be connected as a workspace folder.`,
            title: 'Could not open that folder',
            variant: 'destructive',
          });
          return null;
        }
        return handle;
      } catch (error: unknown) {
        const message = describeBoundaryError(error);
        logger.warn('Folder connection refused', { message, origin, path });
        if (
          error instanceof BoundaryFailureError &&
          error.failure.kind === 'refusal' &&
          error.failure.category === 'authorization' &&
          (error.code === 'workspace.never-granted' ||
            error.code === 'workspace.managed-not-authorized')
        ) {
          toast({
            action: (
              <ToastAction
                altText="Choose this folder in the system picker to grant access"
                data-testid="workspace-connect-grant-action"
                onClick={() => void openPicker()}
              >
                Add folder…
              </ToastAction>
            ),
            description: `${path}: ${message}`,
            // Persistent for the same reason the rewind redo toast is: this
            // toast IS the remedy, and a 5s default would strand it.
            persistent: true,
            title: 'BrainStrike has not been granted access to this folder',
            variant: 'destructive',
          });
          return null;
        }
        toast({
          description: message,
          title: 'Could not open that folder',
          variant: 'destructive',
        });
        return null;
      }
    },
    [addRootDirectoryByPath, openPicker]
  );

  // The CAPABILITY decides whether the entry point exists — gating the spread
  // on `addRootDirectoryByPath` rather than on the callback keeps the
  // render-time condition free of the callback's own deps. Same shape for
  // `openPicker`, gated on the FSA capability probe.
  return {
    ...(isFileSystemAccessSupported().supported ? { openPicker } : {}),
    ...(addRootDirectoryByPath ? { connectPath } : {}),
  };
}
