import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { ipcMain } from 'electron';
import { indexSearchContract } from './ipc-domains/index-search.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

/** Root composes the authoritative runtime, complete-scan receipts and separate read-only grep host. */
export function registerIndexSearchIpcHandlers(capability: IndexSearchCapability): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const failure = { category: 'native-index', code: 'native-index-failed' };
  registerDomain(registry, 'workspace', indexSearchContract, {
    coverage: (request) => settleIpcResult(failure, () => capability.coverage(request)),
    grep: (request) => settleIpcResult(failure, () => capability.grep(request)),
    search: (request) => settleIpcResult(failure, () => capability.search(request)),
    status: () => settleIpcResult(failure, () => capability.status()),
  });
  return () => registry.unregisterAll();
}
