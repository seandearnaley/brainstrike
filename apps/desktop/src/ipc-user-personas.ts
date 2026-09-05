import type { AssistantPersonasListResult } from '@brainstrike/assistant-contract';
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
  listPersonas: () => Promise<AssistantPersonasListResult> = createUserPersonasListHandler()
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'userPersonas', userPersonasContract, {
    list: () => settleIpcResult({ category: 'userPersonas', code: 'list_failed' }, listPersonas),
  });
  return () => {
    registry.unregisterAll();
  };
}
