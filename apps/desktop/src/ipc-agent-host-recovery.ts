import { ipcMain } from 'electron';
import { agentHostRecoveryContract } from './ipc-domains/agent-host-recovery.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

export interface AgentHostRecoveryHandlers {
  readonly restartHost: () => Promise<void>;
  readonly showDataFolder: () => Promise<void>;
}

/** Registers the damaged-store notice's restart and data-folder actions (BST-1880). */
export function registerAgentHostRecoveryIpcHandlers(
  handlers: AgentHostRecoveryHandlers
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'agent', agentHostRecoveryContract, {
    restartHost: () =>
      settleIpcResult({ category: 'agent', code: 'agent-host.restart-failed' }, () =>
        handlers.restartHost()
      ),
    showDataFolder: () =>
      settleIpcResult({ category: 'agent', code: 'agent-host.data-folder-failed' }, () =>
        handlers.showDataFolder()
      ),
  });
  return () => {
    registry.unregisterAll();
  };
}
