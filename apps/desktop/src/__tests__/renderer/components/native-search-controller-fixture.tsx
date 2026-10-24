import { RootIdentityProvider } from '@brainstrike/app-shell/roots/root-identity-context';
import { useWorkspaceSearchController } from '@brainstrike/app-shell/use-workspace-search-controller';
import type {
  IndexerCoverage,
  IndexerStatus,
  IndexLifecycleCapability,
  IndexSearchCapability,
  NativeIndexLifecycleObservation,
  NativeIndexObservation,
} from '@brainstrike/indexing-contract/indexer-client';
import { SearchEmbedderProvider } from '@brainstrike/vector-management';
import { useNativeWorkspaceSearchDependencies } from '@brainstrike/workspace-search/core';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { NativeSearchProvider } from '../../../renderer/components/native-search-provider';

export function mountNativeSearchController(
  ready: Extract<IndexerStatus, { kind: 'ready' }>,
  cloneObservations = true,
  coverageOverride?: IndexSearchCapability['coverage']
) {
  const withSourceProof = (status: IndexerStatus): IndexerStatus =>
    status.kind !== 'ready' || status.sourceObservation
      ? status
      : {
          ...status,
          sourceObservation: {
            ownerGeneration: 11,
            readiness: status.rootReadiness.map(({ rootId, scanComplete }) => ({
              generation: 1,
              mutationRevision: 12,
              scanComplete,
              scope: { kind: 'workspace' as const, rootId },
            })),
          },
        };
  let observation: IndexerStatus = withSourceProof(ready);
  const counts = { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 };
  const observedCoverage: IndexerCoverage = {
    embedding: ready.embedding,
    roots: [{ rootId: 'root-a', ...counts }],
    storeId: ready.storeId,
    totals: counts,
    vectorCoverageComplete: true,
  };
  const response = {
    candidateCount: 0,
    candidatesTruncated: false,
    embedding: ready.embedding,
    hits: [],
    scanLimited: false,
    sourceComplete: true,
    sourceObservation: {
      ownerGeneration: 11,
      readiness: [
        {
          generation: 1,
          mutationRevision: 12,
          scanComplete: false,
          scope: { kind: 'workspace' as const, rootId: 'root-a' },
        },
      ],
    },
    storeId: ready.storeId,
    truncated: false,
  };
  const readCoverage = coverageOverride ?? (async () => observedCoverage);
  const lifecycleListeners = new Set<(value: NativeIndexObservation) => void>();
  let lifecycle: NativeIndexLifecycleObservation = { generation: 1, kind: 'ready' };
  /** What Main pushes after a change: its lifecycle and the status it read then. */
  const push = (): void => {
    const status = cloneObservations ? structuredClone(observation) : observation;
    for (const listener of lifecycleListeners) {
      listener({ lifecycle, progress: { kind: 'read', status } });
    }
  };
  let capability: IndexSearchCapability & IndexLifecycleCapability = {
    coverage: vi.fn(readCoverage),
    coverageBatch: vi.fn<IndexSearchCapability['coverageBatch']>(async () => {
      const status = cloneObservations ? structuredClone(observation) : observation;
      if (status.kind !== 'ready') {
        return { kind: 'blocked', reason: status.reason };
      }
      return { coverage: [await readCoverage({ rootIds: ['root-a'] })], kind: 'current', status };
    }),
    grep: vi.fn(async () => response),
    onLifecycleChanged: (listener) => {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    rebuild: vi.fn(),
    search: vi.fn(async () => response),
    status: vi.fn(async () => (cloneObservations ? structuredClone(observation) : observation)),
  };
  let identities = new Map([['adapter-a', 'root-a']]);
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <SearchEmbedderProvider>
        <NativeSearchProvider capability={capability}>
          <RootIdentityProvider dbRootIdByAdapterRootId={identities}>
            {children}
          </RootIdentityProvider>
        </NativeSearchProvider>
      </SearchEmbedderProvider>
    );
  }
  const mounted = renderHook(
    () => ({
      controller: useWorkspaceSearchController(),
      dependencies: useNativeWorkspaceSearchDependencies(),
    }),
    { wrapper: Wrapper }
  );
  return {
    ...mounted,
    capability,
    emitLifecycle: (value: NativeIndexLifecycleObservation) => {
      lifecycle = value;
      push();
    },
    observedCoverage,
    /** Main pushes the status it reads after a scan starts, settles or is invalidated. */
    publish: push,
    refresh: (next: IndexerStatus) => {
      observation = withSourceProof(next);
    },
    replaceCapability: () => {
      capability = { ...capability };
    },
    replaceRootBinding: () => {
      identities = new Map([['adapter-b', 'root-a']]);
    },
    response,
  };
}
