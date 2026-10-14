import type {
  IndexChunkBoundsCapability,
  IndexRootRegistrationCapability,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { ipcMain } from 'electron';
import { indexSearchContract } from './ipc-domains/index-search.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

/** Root composes the authoritative runtime, complete-scan receipts and separate read-only grep host. */
export function registerIndexSearchIpcHandlers(
  capability: IndexSearchCapability & IndexChunkBoundsCapability,
  registration: IndexRootRegistrationCapability
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const failure = { category: 'native-index', code: 'native-index-failed' };
  registerDomain(registry, 'workspace', indexSearchContract, {
    coverage: (request) => settleIpcResult(failure, () => capability.coverage(request)),
    coverageBatch: (requests) => settleIpcResult(failure, () => capability.coverageBatch(requests)),
    fileChunks: (request) => settleIpcResult(failure, () => capability.fileChunks(request)),
    grep: (request) => settleIpcResult(failure, () => capability.grep(request)),
    rebuild: () => settleIpcResult(failure, () => capability.rebuild()),
    rootsRegistered: () => settleIpcResult(failure, () => registration.rootsRegistered()),
    search: (request) => settleIpcResult(failure, () => capability.search(request)),
    status: () => settleIpcResult(failure, () => capability.status()),
  });
  return () => registry.unregisterAll();
}
