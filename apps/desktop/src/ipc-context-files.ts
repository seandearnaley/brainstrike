import type { WorkspaceContextFileStatus } from '@brainstrike/assistant-contract/context-files-bridge';
import { ipcMain } from 'electron';
import { scanWorkspaceContextFilesForReview } from './ipc-context-files-handlers';
import { contextFilesContract } from './ipc-domains/context-files.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

export function registerContextFilesIpcHandlers(
  scanContextFiles: () => Promise<WorkspaceContextFileStatus[]> = () =>
    scanWorkspaceContextFilesForReview()
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
