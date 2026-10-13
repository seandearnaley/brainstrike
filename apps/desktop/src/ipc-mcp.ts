import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import { dialog, ipcMain } from 'electron';
import { mcpPathSelectionContract } from './ipc-domains/mcp.contract';
import { attachMcpBridges } from './mcp/bridges';
import { getMainMcpHostControl, type MainMcpHostControl } from './mcp/main-host-control';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';

/**
 * Main's remaining MCP surfaces (BST-1930 c5d): the native config picker,
 * which hands the chosen file to the host, and the MCP App shell. The host
 * owns the MCP config, extension dials, discovery, tool preferences, server
 * status, lifecycle control, Tasks cards, global server input and content.
 */
const logger = createLogger('DesktopMcpIpc');

type McpIpcRuntime = Pick<MainMcpHostControl, 'pickConfigPath'>;
type McpSettingsLifecycleRuntime = Pick<MainMcpHostControl, 'resetSettings' | 'resumeSettings'>;

/** Closed across a factory reset; the picker refuses while it is. */
let mcpSurfacesOpen = true;
let pendingConfigPathSelection: {
  readonly selection: Promise<string | null>;
  readonly senderId: number;
} | null = null;

function clearPendingConfigPathSelection(selection: Promise<string | null>): void {
  if (pendingConfigPathSelection?.selection === selection) {
    pendingConfigPathSelection = null;
  }
}

/** One native picker per window at a time; the chosen file becomes the host's config. */
function selectMcpConfigPath(runtime: McpIpcRuntime, senderId: number): Promise<string | null> {
  if (!mcpSurfacesOpen) {
    return Promise.reject(new Error('MCP settings are closed for a factory reset'));
  }
  if (pendingConfigPathSelection !== null) {
    if (pendingConfigPathSelection.senderId !== senderId) {
      return Promise.reject(
        new Error('MCP config path selection is already active for another window')
      );
    }
    return pendingConfigPathSelection.selection;
  }
  const selection = dialog
    .showOpenDialog({
      filters: [
        { extensions: ['json'], name: 'JSON Config' },
        { extensions: ['*'], name: 'All Files' },
      ],
      properties: ['openFile'],
      title: 'Select MCP Configuration File',
    })
    .then(async (result) => {
      const selectedPath = result.canceled ? undefined : result.filePaths[0];
      if (!selectedPath) {
        return null;
      }
      return (await runtime.pickConfigPath(path.resolve(selectedPath))).path;
    });
  pendingConfigPathSelection = { selection, senderId };
  void selection.then(
    () => clearPendingConfigPathSelection(selection),
    () => clearPendingConfigPathSelection(selection)
  );
  return selection;
}

/** Main's shutdown step: the host owns and joins the runtime; Main closes its surfaces. */
export async function cleanupMcpRuntimeForShutdown(
  control: Pick<MainMcpHostControl, 'close'> = getMainMcpHostControl()
): Promise<void> {
  mcpSurfacesOpen = false;
  pendingConfigPathSelection = null;
  control.close();
  logger.info('MCP surfaces closed for shutdown');
}

/** Content clearing retires the host, but retains its durable MCP preferences. */
export function suspendMcpSurfacesForContentClear(): Promise<void> {
  mcpSurfacesOpen = false;
  pendingConfigPathSelection = null;
  return Promise.resolve();
}

/** Factory reset: close Main's surfaces, then the host retires its MCP settings. */
export async function resetMcpRuntimeForFactoryReset(
  runtime: McpSettingsLifecycleRuntime = getMainMcpHostControl()
): Promise<void> {
  mcpSurfacesOpen = false;
  pendingConfigPathSelection = null;
  await runtime.resetSettings();
}

/** After a factory reset: the host reopens its settings (restoring them on failure), then Main's surfaces. */
export async function resumeMcpRuntimeAfterFactoryReset(
  runtime: McpSettingsLifecycleRuntime = getMainMcpHostControl(),
  outcome: 'failed' | 'succeeded' = 'succeeded'
): Promise<void> {
  if (mcpSurfacesOpen) {
    return;
  }
  await runtime.resumeSettings(outcome);
  mcpSurfacesOpen = true;
}

export function registerMcpIpcHandlers({ runtime }: { runtime: McpIpcRuntime }): () => void {
  logger.debug('Registering MCP IPC handlers');
  mcpSurfacesOpen = true;
  const registry = createDesktopIpcRegistry({ ipcMain });
  attachMcpBridges(registry);
  registry.registerAuthorizedInvoke(
    'mcp',
    mcpPathSelectionContract.selectPath.channel,
    { roles: mcpPathSelectionContract.selectPath.roles },
    (event, ...raw): Promise<string | null> => {
      mcpPathSelectionContract.selectPath.parseArgs(raw);
      return selectMcpConfigPath(runtime, event.sender.id);
    }
  );
  return () => {
    registry.unregisterAll();
  };
}
