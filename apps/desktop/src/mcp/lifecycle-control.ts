import type { McpHostSnapshot, McpHostWatchEvent } from '@brainstrike/assistant-contract';
import { BrowserWindow } from 'electron';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from '../platform/desktop-ipc-channels';

export function notifyMcpStatusUpdated(event: McpHostWatchEvent): void {
  const payload: McpHostSnapshot = structuredClone(event);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(DESKTOP_PRELOAD_IPC_CHANNELS.mcp.statusUpdated, payload);
    }
  }
}
