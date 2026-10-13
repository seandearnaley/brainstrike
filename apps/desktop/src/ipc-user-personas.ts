import type {
  AssistantPersonasListResult,
  ModelCatalogCapability,
} from '@brainstrike/assistant-contract';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import { ipcMain } from 'electron';
import { userPersonasContract } from './ipc-domains/user-personas.contract';
import { createUserPersonasListHandler } from './ipc-user-personas-handlers';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

/**
 * Registers the subagent persona discovery IPC (desktop-only). The Settings →
 * Subagents panel calls `list` to show built-in + user-defined personas
 * (including invalid persona files with their error) scanned from
 * `.brainstrike/agents` across the mounted roots and the home directory.
 */
export function registerUserPersonasIpcHandlers(
  workspaceRoots: WorkspaceRootPort,
  modelCatalog: Pick<ModelCatalogCapability, 'read'>,
  listPersonas: () => Promise<AssistantPersonasListResult> = createUserPersonasListHandler(
    workspaceRoots,
    modelCatalog
  )
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'userPersonas', userPersonasContract, {
    list: () => settleIpcResult({ category: 'userPersonas', code: 'list_failed' }, listPersonas),
  });
  return () => {
    registry.unregisterAll();
  };
}
