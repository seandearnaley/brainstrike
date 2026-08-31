import type {
  McpHostControlRequest,
  McpHostPort,
  McpHostServerSnapshot,
  McpHostSnapshot,
  McpHostWatchEvent,
} from '@brainstrike/assistant-contract';
import { BrowserWindow } from 'electron';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from '../platform/desktop-ipc-channels';

type DestructiveMcpHostControlRequest = Omit<McpHostControlRequest, 'action'> & {
  readonly action: 'disconnect' | 'reauthorize';
};

export function notifyMcpStatusUpdated(event: McpHostWatchEvent): void {
  const payload: McpHostSnapshot = structuredClone(event);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(DESKTOP_PRELOAD_IPC_CHANNELS.mcp.statusUpdated, payload);
    }
  }
}

export async function controlDestructiveMcpLifecycle(
  host: Pick<McpHostPort, 'control'>,
  request: DestructiveMcpHostControlRequest,
  reloadConfig: () => Promise<void>
): Promise<McpHostServerSnapshot> {
  let controlFailure: unknown;
  let result: McpHostServerSnapshot | undefined;
  try {
    result = await host.control(request);
  } catch (cause) {
    controlFailure = cause;
  }
  try {
    await reloadConfig();
  } catch (reloadFailure) {
    if (controlFailure !== undefined) {
      throw new AggregateError(
        [controlFailure, reloadFailure],
        'MCP lifecycle control and config reload both failed'
      );
    }
    throw reloadFailure;
  }
  if (controlFailure !== undefined) {
    throw controlFailure;
  }
  if (result === undefined) {
    throw new Error('MCP lifecycle control completed without a result');
  }
  return result;
}
