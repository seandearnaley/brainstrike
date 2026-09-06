/**
 * Mounts the desktop folder-connection subscriptions ONCE at the visible-UI
 * root (BST-1393). Same shape and same mounting rule as `CommandPaletteHost` /
 * `QuickOpenHost`: rendered only from `RootLayoutContent`, which only the
 * visible-UI renderer mounts, so the hidden embedding/llm/chunking hosts never
 * reach it and need no role check here.
 *
 * Renders nothing. Web resolves no bridge and subscribes to nothing.
 */
import { createLogger } from '@brainstrike/logging';
import { type ReactElement, useEffect } from 'react';
import { useConnectFolder } from './use-connect-folder';
import {
  isWorkspaceOpenPathRequest,
  resolveWorkspaceConnectBridge,
} from './workspace-connect-bridge';

const logger = createLogger('WorkspaceConnectHost');

export function WorkspaceConnectHost(): ReactElement | null {
  const { connectPath, openPicker } = useConnectFolder();

  useEffect(() => {
    const bridge = resolveWorkspaceConnectBridge();
    if (!(bridge && openPicker)) {
      return;
    }
    return bridge.onOpenFolderPicker(() => {
      void openPicker();
    });
  }, [openPicker]);

  useEffect(() => {
    const bridge = resolveWorkspaceConnectBridge();
    if (!(bridge && connectPath)) {
      return;
    }
    const unsubscribe = bridge.onOpenPath((request: unknown) => {
      if (!isWorkspaceOpenPathRequest(request)) {
        // Dropped, not coerced: an empty path forwarded to fs:addRootByPath
        // would come back as a grant refusal and describe a wiring bug as a
        // permission problem.
        logger.error('Ignored a malformed workspace open-path request', { request });
        return;
      }
      void connectPath(request);
    });
    // Tell main a listener now exists, in the SAME effect, immediately after
    // subscribing — main gates its queued-request delivery on this ping
    // (plus the window having finished loading) rather than treating
    // `did-finish-load` alone as proof the renderer is listening.
    bridge.notifyOpenPathReady();
    return unsubscribe;
  }, [connectPath]);

  return null;
}
