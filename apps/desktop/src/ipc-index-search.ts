import type { IndexConfig } from '@brainstrike/assistant-contract/index-config';
import type {
  IndexChunkBoundsCapability,
  IndexRootRegistrationCapability,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { ipcMain } from 'electron';
import { hostedQueryEmbedding } from './hosted-embeddings';
import { indexSearchContract } from './ipc-domains/index-search.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

/** Root composes the authoritative runtime, complete-scan receipts and separate read-only grep host. */
export function registerIndexSearchIpcHandlers(
  capability: IndexSearchCapability & IndexChunkBoundsCapability,
  registration: IndexRootRegistrationCapability,
  config: { read(): Promise<IndexConfig>; update(patch: unknown): Promise<IndexConfig> }
): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const failure = { category: 'native-index', code: 'native-index-failed' };
  registerDomain(registry, 'workspace', indexSearchContract, {
    coverage: (request) => settleIpcResult(failure, () => capability.coverage(request)),
    coverageBatch: (requests) => settleIpcResult(failure, () => capability.coverageBatch(requests)),
    // An aborted search drops the answer in the renderer; the request itself is one HTTP call.
    embedQuery: (request) =>
      settleIpcResult(failure, () => hostedQueryEmbedding(request, new AbortController().signal)),
    fileChunks: (request) => settleIpcResult(failure, () => capability.fileChunks(request)),
    grep: (request) => settleIpcResult(failure, () => capability.grep(request)),
    readConfig: () => settleIpcResult(failure, () => config.read()),
    rebuild: () => settleIpcResult(failure, () => capability.rebuild()),
    rootsRegistered: () => settleIpcResult(failure, () => registration.rootsRegistered()),
    search: (request) => settleIpcResult(failure, () => capability.search(request)),
    status: () => settleIpcResult(failure, () => capability.status()),
    updateConfig: (patch) => settleIpcResult(failure, () => config.update(patch)),
  });
  return () => registry.unregisterAll();
}
