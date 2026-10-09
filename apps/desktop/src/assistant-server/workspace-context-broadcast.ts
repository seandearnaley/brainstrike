/**
 * Main's delivery of a workspace-context write-back (BST-743) to the visible
 * app windows over the shared IPC channel catalog. The validation half is
 * Electron-free (workspace-context-tools.ts), so the desktop agent host runs
 * it and asks Main to deliver.
 */
import type {
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
} from '@brainstrike/types';
import { BrowserWindow } from 'electron';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { getWindowRole } from '../window-role';
import type { WorkspaceContextBroadcaster } from './workspace-context-tools';

const WORKSPACE_CONTEXT_SELECTION_EVENT =
  DESKTOP_IPC_CHANNELS.agent.workspaceContextSelectionUpdate;
const WORKSPACE_CONTEXT_TAPESTRY_EVENT = DESKTOP_IPC_CHANNELS.agent.workspaceContextTapestryUpdate;

function broadcastWorkspaceContextEvent(
  channel: typeof WORKSPACE_CONTEXT_SELECTION_EVENT | typeof WORKSPACE_CONTEXT_TAPESTRY_EVENT,
  payload: AssistantWorkspaceContextSelectionUpdatePayload | AssistantWorkspaceTapestryUpdatePayload
): number {
  let notifiedWindowCount = 0;
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (browserWindow.isDestroyed()) {
      continue;
    }
    if (getWindowRole(browserWindow) !== 'visible-ui') {
      continue;
    }
    browserWindow.webContents.send(channel, payload);
    notifiedWindowCount += 1;
  }
  return notifiedWindowCount;
}

export const mainWorkspaceContextBroadcaster: WorkspaceContextBroadcaster = {
  selection: async (payload) =>
    broadcastWorkspaceContextEvent(WORKSPACE_CONTEXT_SELECTION_EVENT, payload),
  tapestry: async (payload) =>
    broadcastWorkspaceContextEvent(WORKSPACE_CONTEXT_TAPESTRY_EVENT, payload),
};
