import type { WorkspaceContextFileStatus } from '@brainstrike/assistant-contract/context-files-bridge';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import { ipcMain } from 'electron';
import { scanWorkspaceContextFilesForReview } from './ipc-context-files-handlers';
import { contextFilesContract } from './ipc-domains/context-files.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

export function registerContextFilesIpcHandlers(
  workspaceRoots: WorkspaceRootPort,
  scanContextFiles: () => Promise<WorkspaceContextFileStatus[]> = () =>
    scanWorkspaceContextFilesForReview({ workspaceRoots })
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  registerDomain(registry, 'contextFiles', contextFilesContract, {
    scan: () =>
      settleIpcResult({ category: 'contextFiles', code: 'scan_failed' }, scanContextFiles),
  });
  return () => {
    registry.unregisterAll();
  };
}
