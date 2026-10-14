import type { SourceFilesCapability } from '@brainstrike/assistant-contract';
import { ipcMain } from 'electron';
import { sourceFilesContract } from './ipc-domains/source-files.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';
export function registerSourceFilesIpc(files: SourceFilesCapability): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const settle = <T>(work: () => Promise<T>) =>
    settleIpcResult({ category: 'sourceFiles', code: 'source_files_failed' }, work);
  registerDomain(registry, 'sourceFiles', sourceFilesContract, {
    chunks: (request) => settle(() => files.chunks(request)),
    delete: (ids) => settle(() => files.delete(ids)),
    import: (input) => settle(() => files.import(input)),
    list: () => settle(() => files.list()),
    read: (ids, max) => settle(() => files.read(ids, max)),
  });
  return () => registry.unregisterAll();
}
