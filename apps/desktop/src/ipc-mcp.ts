import path from 'node:path';
import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { dialog, ipcMain } from 'electron';
import { mcpContract, mcpPathSelectionContract } from './ipc-domains/mcp.contract';
import { attachMcpBridges } from './mcp/bridges';
import { registerMcpContentIpc } from './mcp/content-ipc';
import { getDesktopMcpHostRuntime } from './mcp/host-runtime';
import type { RemoteMcpRuntime } from './mcp/remote-runtime';
import { createDesktopIpcRegistry, registerDomain } from './platform/desktop-ipc-registry';
import type { Handlers } from './platform/ipc-contract';

/**
 * Main's remaining MCP surfaces (BST-1930 c5c): content and Apps reach the
 * host's runtime through the private proxy until c5d makes them public host
 * methods. The host owns the MCP config, extension dials, discovery, tool
 * preferences, server status, lifecycle control, Tasks cards and global server
 * input; Main keeps the native config picker, which hands the chosen file to
 * the host, and the preload's status read for MCP App resources (until c5d).
 */
const logger = createLogger('DesktopMcpIpc');

type McpIpcRuntime = Pick<RemoteMcpRuntime, 'host' | 'pickConfigPath'>;
type McpSettingsLifecycleRuntime = Pick<RemoteMcpRuntime, 'resetSettings' | 'resumeSettings'>;

/** Closed across a factory reset; content and the picker refuse while it is. */
let mcpSurfacesOpen = true;
let pendingConfigPathSelection: {
  readonly selection: Promise<string | null>;
  readonly senderId: number;
} | null = null;
const mcpContentLifecycle = {
  barrier: () => Promise.resolve(),
  isOpen: () => mcpSurfacesOpen,
};

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

/** Main's shutdown step: the host owns and joins the runtime; Main detaches its proxy. */
export async function cleanupMcpRuntimeForShutdown(
  runtime: Pick<RemoteMcpRuntime, 'host'> = getDesktopMcpHostRuntime()
): Promise<void> {
  mcpSurfacesOpen = false;
  pendingConfigPathSelection = null;
  const report = await runtime.host.close();
  if (report.failures.length > 0) {
    throw new AggregateError(report.failures, 'MCP runtime shutdown cleanup failed');
  }
  logger.info('MCP runtime shutdown cleanup completed', {
    hostCloseReport: report,
    legacyClientsClosed: true,
  });
}

/** Factory reset: close Main's surfaces, then the host retires its MCP settings. */
export async function resetMcpRuntimeForFactoryReset(
  runtime: McpSettingsLifecycleRuntime = getDesktopMcpHostRuntime()
): Promise<void> {
  mcpSurfacesOpen = false;
  pendingConfigPathSelection = null;
  await runtime.resetSettings();
}

/** After a factory reset: the host reopens its settings (restoring them on failure), then Main's surfaces. */
export async function resumeMcpRuntimeAfterFactoryReset(
  runtime: McpSettingsLifecycleRuntime = getDesktopMcpHostRuntime(),
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
  const handlers: Handlers<typeof mcpContract> = {
    getServerStatusSnapshot: async (): Promise<McpHostSnapshot> =>
      structuredClone(runtime.host.snapshot()),
  };
  registry.registerAuthorizedInvoke(
    'mcp',
    mcpPathSelectionContract.selectPath.channel,
    { roles: mcpPathSelectionContract.selectPath.roles },
    (event, ...raw): Promise<string | null> => {
      mcpPathSelectionContract.selectPath.parseArgs(raw);
      return selectMcpConfigPath(runtime, event.sender.id);
    }
  );
  registerDomain(registry, 'mcp', mcpContract, handlers);
  registerMcpContentIpc(registry, runtime, mcpContentLifecycle);
  return () => {
    registry.unregisterAll();
  };
}
